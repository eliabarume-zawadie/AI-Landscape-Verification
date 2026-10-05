import { and, eq, inArray } from "drizzle-orm";
import type { Thresholds } from "@alvip/shared";
import { recordAudit, type Actor } from "../../audit/audit";
import { evidence, evidenceBundleItems, imageAnalysis, images } from "../../db/schema";
import { isConfirmedPair, type EvaluatedPair } from "../../domain/beforeAfter";
import { buildBundle, type EvidenceBundle } from "../../domain/bundle";
import type { ServiceAssessment } from "../../domain/evidence";
import type { JobContext } from "../jobHandler";

/** PRD §20–23: build and persist the reviewer's evidence bundle and the image order. */
export async function runBundleStage(
  ctx: JobContext,
  input: {
    locationId: string;
    runId: string;
    assessments: ServiceAssessment[];
    pairs: EvaluatedPair[];
    establishedBy: Map<string, string[]>;
    thresholds: Thresholds;
    actor: Actor;
  },
): Promise<EvidenceBundle> {
  const { db } = ctx;
  const rows = await db
    .select({
      analysisId: imageAnalysis.id,
      imageId: images.id,
      ref: images.externalRef,
      usable: imageAnalysis.usable,
      isRep: imageAnalysis.isDuplicateRepresentative,
      group: imageAnalysis.duplicateGroup,
      quality: imageAnalysis.qualityScore,
    })
    .from(imageAnalysis)
    .innerJoin(images, eq(images.id, imageAnalysis.imageId))
    .where(eq(imageAnalysis.runId, input.runId));

  const bundle = buildBundle({
    assessments: input.assessments,
    images: rows.map((r) => ({
      imageId: r.imageId,
      ref: r.ref,
      usable: r.usable ?? false,
      isRepresentative: r.isRep ?? false,
      duplicateGroup: r.group ?? r.imageId,
      qualityScore: r.quality ?? 0,
    })),
    pairs: input.pairs
      .filter((p) => p.pairId)
      .map((p) => ({
        pairId: p.pairId,
        beforeId: p.beforeId,
        afterId: p.afterId,
        confirmed: isConfirmedPair(p, input.thresholds.pairing),
        establishes: [...input.establishedBy.entries()].filter(([, ids]) => ids.includes(p.pairId)).map(([s]) => s),
      })),
    thresholds: input.thresholds,
  });

  await db.transaction(async (tx) => {
    if (bundle.entries.length > 0) {
      await tx.insert(evidenceBundleItems).values(
        bundle.entries.map((e) => ({ runId: input.runId, imageId: e.imageId, rank: e.rank, reasons: e.reasons, services: e.services })),
      );
    }
    for (const r of rows) {
      await tx.update(imageAnalysis).set({ evidenceRank: bundle.imageRanks.get(r.imageId) ?? null }).where(eq(imageAnalysis.id, r.analysisId));
    }
    for (const sb of bundle.byService) {
      for (const [i, imageId] of sb.imageIds.entries()) {
        await tx
          .update(evidence)
          .set({ inBundle: true, rank: i + 1 })
          .where(and(eq(evidence.runId, input.runId), eq(evidence.serviceCode, sb.service), inArray(evidence.imageId, [imageId])));
      }
    }
    await recordAudit(tx, {
      eventType: "EVIDENCE_BUNDLED",
      actor: input.actor,
      locationId: input.locationId,
      runId: input.runId,
      data: {
        totalImages: bundle.totalImages,
        bundledImages: bundle.entries.length,
        mustInclude: bundle.mustIncludeCount,
        perService: Object.fromEntries(bundle.byService.map((s) => [s.service, s.imageIds.length])),
        maxImages: input.thresholds.bundle.max_images,
      },
    });
  });
  return bundle;
}
