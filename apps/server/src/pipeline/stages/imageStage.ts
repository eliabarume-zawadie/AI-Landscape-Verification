import { asc, eq, sql } from "drizzle-orm";
import type { Thresholds } from "@alvip/shared";
import { recordAudit, type Actor } from "../../audit/audit";
import { imageAnalysis, images, processingRuns } from "../../db/schema";
import { dedupe } from "../../domain/dedup";
import { assessQuality, type ImageMetrics, type QualityAssessment } from "../../domain/quality";
import { ImageFetchError } from "../../integrations/images/ImageProvider";
import { WorkItemError } from "../../services/errors";
import { analyzeImageBytes, type ImageFingerprints } from "../imageMetrics";
import type { JobContext } from "../jobHandler";
import { mapLimit } from "../mapLimit";

export interface ImageStageSummary {
  total: number;
  fetched: number;
  reused: number;
  missing: number;
  /** Present, decodable, accepted format, within size limit. */
  readable: number;
  usable: number;
  uniqueImages: number;
  exactDuplicates: number;
  nearDuplicates: number;
  issueCounts: Record<string, number>;
}

interface PerImage {
  imageId: string;
  ordinal: number | null;
  metrics: ImageMetrics;
  fingerprints: ImageFingerprints | null;
  quality: QualityAssessment;
}

const UNREADABLE = new Set(["MISSING", "CORRUPT", "UNSUPPORTED_FORMAT", "TOO_LARGE"]);

export const storageKeyFor = (locationId: string, imageId: string) => `locations/${locationId}/${imageId}`;

/**
 * PRD §13–15: fetch every image (reusing stored bytes), validate format, measure quality,
 * and cluster duplicates. Writes one image_analysis row per image for this run.
 *
 *  - A missing/forbidden image is recorded, not fatal.
 *  - A transient fetch error fails the job (retried); bytes already stored are reused.
 *  - If no image has decodable content at all, the location goes to the Exception Lane.
 */
export async function runImageStage(
  ctx: JobContext,
  input: { locationId: string; runId: string; thresholds: Thresholds; actor: Actor },
): Promise<ImageStageSummary> {
  const { db, integrations } = ctx;
  const rows = await db
    .select()
    .from(images)
    .where(eq(images.locationId, input.locationId))
    .orderBy(asc(images.ordinal), asc(images.externalRef));

  let fetched = 0;
  let reused = 0;
  let processed = 0;

  const perImage = await mapLimit(rows, ctx.env.IMAGE_FETCH_CONCURRENCY, async (row): Promise<PerImage> => {
    let bytes: Buffer | null = null;
    if (row.storageKey && !row.purgedAt) {
      bytes = await integrations.storage.get(row.storageKey);
      if (bytes) reused++;
    }
    if (!bytes) {
      try {
        const got = await integrations.images.fetch(row.locator);
        bytes = got.bytes;
        const key = storageKeyFor(input.locationId, row.id);
        await integrations.storage.put(key, bytes, got.contentType ?? "application/octet-stream");
        await db
          .update(images)
          .set({
            storageKey: key,
            contentType: got.contentType ?? null,
            downloadedAt: sql`now()`,
            downloadError: null,
            purgedAt: null,
            ...(got.metadata ? { metadata: got.metadata } : {}),
          })
          .where(eq(images.id, row.id));
        fetched++;
      } catch (err) {
        if (err instanceof ImageFetchError && err.kind !== "TRANSIENT") {
          await db.update(images).set({ downloadError: `${err.kind}: ${err.message}`.slice(0, 500) }).where(eq(images.id, row.id));
          const metrics: ImageMetrics = { present: false, decodable: false, bytes: 0 };
          return { imageId: row.id, ordinal: row.ordinal, metrics, fingerprints: null, quality: assessQuality(metrics, input.thresholds.quality) };
        }
        throw err; // transient → job retry
      }
    }

    const analyzed = await analyzeImageBytes(bytes, { maxInputPixels: input.thresholds.quality.max_input_pixels });
    await db
      .update(images)
      .set({
        sha256: analyzed.fingerprints.sha256,
        perceptualHash: analyzed.fingerprints.dhash,
        fingerprint: analyzed.fingerprints.fingerprint ? Buffer.from(analyzed.fingerprints.fingerprint).toString("base64") : null,
        format: analyzed.metrics.format ?? null,
        width: analyzed.metrics.width ?? null,
        height: analyzed.metrics.height ?? null,
        bytes: analyzed.metrics.bytes,
      })
      .where(eq(images.id, row.id));

    if (++processed % 20 === 0) await ctx.heartbeat();
    return {
      imageId: row.id,
      ordinal: row.ordinal,
      metrics: analyzed.metrics,
      fingerprints: analyzed.fingerprints,
      quality: assessQuality(analyzed.metrics, input.thresholds.quality),
    };
  });

  const dedup = dedupe(
    perImage.map((p) => ({
      imageId: p.imageId,
      ordinal: p.ordinal,
      sha256: p.fingerprints?.sha256 ?? null,
      dhash: p.fingerprints?.dhash ?? null,
      fingerprint: p.fingerprints?.fingerprint ?? null,
      usable: p.quality.usable,
      qualityScore: p.quality.score,
    })),
    input.thresholds.duplicates,
  );

  if (perImage.length > 0) {
    await db.insert(imageAnalysis).values(
      perImage.map((p) => {
        const d = dedup.results.get(p.imageId)!;
        return {
          runId: input.runId,
          imageId: p.imageId,
          qualityScore: p.quality.score,
          usable: p.quality.usable,
          qualityIssues: p.quality.issues,
          qualityMetrics: p.metrics,
          duplicateGroup: d.groupId,
          isDuplicateRepresentative: d.isRepresentative,
          duplicateKind: d.duplicateKind,
        };
      }),
    );
  }

  const issueCounts: Record<string, number> = {};
  for (const p of perImage) for (const i of p.quality.issues) issueCounts[i] = (issueCounts[i] ?? 0) + 1;
  const summary: ImageStageSummary = {
    total: perImage.length,
    fetched,
    reused,
    missing: perImage.filter((p) => !p.metrics.present).length,
    readable: perImage.filter((p) => !p.quality.issues.some((i) => UNREADABLE.has(i))).length,
    usable: perImage.filter((p) => p.quality.usable).length,
    uniqueImages: dedup.uniqueCount,
    exactDuplicates: dedup.exactDuplicates,
    nearDuplicates: dedup.nearDuplicates,
    issueCounts,
  };

  await db.update(processingRuns).set({ uniqueImageCount: dedup.uniqueCount }).where(eq(processingRuns.id, input.runId));
  await recordAudit(db, {
    eventType: "IMAGE_QUALITY_ASSESSED",
    actor: input.actor,
    locationId: input.locationId,
    runId: input.runId,
    data: { ...summary, thresholdsVersion: input.thresholds.version },
  });

  if (summary.readable === 0) {
    throw new WorkItemError(
      `None of the ${summary.total} images could be read (missing, corrupt, or unsupported)`,
      "INVALID_IMAGE",
      "IMAGE_ERROR",
    );
  }
  return summary;
}
