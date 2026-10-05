import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { recordAudit, type Actor } from "../../audit/audit";
import type { ActiveConfig } from "../../config/configStore";
import { imageAnalysis, images, modelVersions, processingRuns, visionCache } from "../../db/schema";
import {
  imageAnalysisJsonSchema,
  validateImageAnalysis,
  type ValidatedImageAnalysis,
} from "../../domain/observations";
import type { QualityIssue } from "../../domain/quality";
import { IMAGE_ANALYSIS_PROMPT, loadPrompt, promptLabel, registerPrompt, renderImageAnalysisPrompt } from "../../integrations/vision/prompts";
import type { ProviderResponse } from "../../integrations/vision/VisionProvider";
import { WorkItemError } from "../../services/errors";
import { openImage } from "../imageDecode";
import type { JobContext } from "../jobHandler";
import { mapLimit } from "../mapLimit";

export type AnalysisStatus =
  | "ANALYZED"
  | "CACHED"
  | "SKIPPED_UNUSABLE"
  | "SKIPPED_DUPLICATE"
  | "MALFORMED"
  | "REFUSED";

export interface VisionStageSummary {
  candidates: number;
  analyzed: number;
  cached: number;
  skippedUnusable: number;
  skippedDuplicate: number;
  malformed: number;
  refused: number;
  validationWarnings: number;
  newlyIrrelevantOrObstructed: number;
  costUsd: number;
  servedModels: string[];
}

/** Visibility problems reported by the model that make an image unusable as evidence. */
const AI_UNUSABLE: Record<string, QualityIssue> = { OBSTRUCTED: "OBSTRUCTED", IRRELEVANT: "IRRELEVANT", TOO_DISTANT: "TOO_DISTANT" };

/**
 * PRD §16–17, §37, §49: vision observations for the unique, usable images of a run.
 *
 *  - Unusable images and non-representative duplicates are not sent (cost + no evidence).
 *  - Results are cached by image hash + prompt + model settings + rules + services.
 *  - Every response is validated; a malformed one is retried once, then recorded as
 *    MALFORMED. A refusal is recorded as REFUSED. Neither ever counts as evidence.
 *  - Provider outages/rate limits throw, so the job is retried with backoff; results
 *    already obtained are in the cache, so retries do not pay twice.
 */
export async function runVisionStage(
  ctx: JobContext,
  input: { locationId: string; runId: string; services: string[]; config: ActiveConfig; actor: Actor },
): Promise<VisionStageSummary> {
  const { db, env } = ctx;
  const provider = ctx.integrations.vision;
  const services = [...input.services].sort();

  const prompt = loadPrompt(env.PROMPTS_DIR, IMAGE_ANALYSIS_PROMPT);
  await registerPrompt(db, prompt);
  await db
    .insert(modelVersions)
    .values({ provider: provider.info.provider, model: provider.info.model, modelVersion: provider.info.modelVersion })
    .onConflictDoNothing();

  const rendered = renderImageAnalysisPrompt(prompt, services.map((s) => input.config.registry.get(s)));
  const schema = imageAnalysisJsonSchema(input.config.registry, services);
  const settingsKey = JSON.stringify({
    prompt: prompt.contentHash,
    provider: provider.info.provider,
    model: provider.info.model,
    modelVersion: provider.info.modelVersion,
    rules: input.config.registry.version,
    services,
    maxSide: env.VISION_MAX_IMAGE_SIDE,
  });

  const rows = await db
    .select({
      analysisId: imageAnalysis.id,
      imageId: images.id,
      externalRef: images.externalRef,
      sha256: images.sha256,
      storageKey: images.storageKey,
      usable: imageAnalysis.usable,
      isRep: imageAnalysis.isDuplicateRepresentative,
      qualityIssues: imageAnalysis.qualityIssues,
    })
    .from(imageAnalysis)
    .innerJoin(images, eq(images.id, imageAnalysis.imageId))
    .where(eq(imageAnalysis.runId, input.runId));

  const summary: VisionStageSummary = {
    candidates: 0,
    analyzed: 0,
    cached: 0,
    skippedUnusable: 0,
    skippedDuplicate: 0,
    malformed: 0,
    refused: 0,
    validationWarnings: 0,
    newlyIrrelevantOrObstructed: 0,
    costUsd: 0,
    servedModels: [],
  };
  const served = new Set<string>();

  const candidates = [];
  for (const r of rows) {
    if (!r.usable) {
      summary.skippedUnusable++;
      await db.update(imageAnalysis).set({ analysisStatus: "SKIPPED_UNUSABLE" }).where(eq(imageAnalysis.id, r.analysisId));
    } else if (!r.isRep) {
      summary.skippedDuplicate++;
      await db.update(imageAnalysis).set({ analysisStatus: "SKIPPED_DUPLICATE" }).where(eq(imageAnalysis.id, r.analysisId));
    } else {
      candidates.push(r);
    }
  }
  summary.candidates = candidates.length;

  let done = 0;
  await mapLimit(candidates, env.VISION_CONCURRENCY, async (row) => {
    const cacheKey = createHash("sha256").update(`${row.sha256}|${settingsKey}`).digest("hex");
    const [hit] = await db.select().from(visionCache).where(eq(visionCache.cacheKey, cacheKey));

    let status: AnalysisStatus;
    let value: ValidatedImageAnalysis | null = null;
    let warnings: string[] = [];
    let validationError: string | null = null;
    let raw: unknown = null;
    let servedModel: string | null = null;
    let cost = 0;
    let latency = 0;

    if (hit) {
      status = "CACHED";
      value = hit.result as ValidatedImageAnalysis;
      servedModel = hit.servedModel;
    } else {
      const bytes = row.storageKey ? await ctx.integrations.storage.get(row.storageKey) : null;
      if (!bytes) throw new WorkItemError(`Image ${row.imageId} bytes missing from storage`, "INTERNAL", "INTEGRATION_ERROR");
      const prepared = await prepareForVision(bytes, env.VISION_MAX_IMAGE_SIDE);

      const call = () =>
        provider.analyzeImage({
          image: { imageId: row.imageId, externalRef: row.externalRef, bytes: prepared, mediaType: "image/jpeg" },
          services,
          prompt: rendered,
          promptLabel: promptLabel(prompt),
          outputSchema: schema,
        });

      let attempt: ProviderResponse = await call();
      let check = attempt.refused ? null : validateImageAnalysis(attempt.output, { registry: input.config.registry, requestedServices: services });
      cost += attempt.usage.costUsd ?? 0;
      latency += attempt.latencyMs;
      if (check && !check.ok) {
        // One retry for malformed output; providers are non-deterministic.
        attempt = await call();
        check = attempt.refused ? null : validateImageAnalysis(attempt.output, { registry: input.config.registry, requestedServices: services });
        cost += attempt.usage.costUsd ?? 0;
        latency += attempt.latencyMs;
      }
      raw = attempt.refused ? { refused: attempt.refused } : attempt.output;
      servedModel = attempt.servedModel;

      if (attempt.refused) {
        status = "REFUSED";
      } else if (check && check.ok) {
        status = "ANALYZED";
        value = check.value;
        warnings = check.warnings;
        await db
          .insert(visionCache)
          .values({ cacheKey, sha256: row.sha256!, result: value, servedModel, costUsd: String(cost) })
          .onConflictDoNothing();
      } else {
        status = "MALFORMED";
        validationError = check && !check.ok ? check.error : "invalid response";
      }
    }

    // Model-reported visibility problems make the image unusable as evidence.
    const aiIssues = (value?.visibilityIssues ?? []).map((i) => AI_UNUSABLE[i]).filter((i): i is QualityIssue => Boolean(i));
    const qualityIssues = [...new Set([...((row.qualityIssues as QualityIssue[]) ?? []), ...aiIssues])];
    if (aiIssues.length > 0) summary.newlyIrrelevantOrObstructed++;

    await db
      .update(imageAnalysis)
      .set({
        analysisStatus: status,
        observations: value,
        rawResponse: raw === null ? null : typeof raw === "string" ? { text: raw.slice(0, 4000) } : raw,
        validationError,
        validationWarnings: warnings,
        servedModel,
        cacheHit: status === "CACHED",
        costUsd: String(cost),
        latencyMs: latency,
        relevant: value ? value.relevant : null,
        ...(aiIssues.length > 0 ? { usable: false, qualityIssues } : {}),
      })
      .where(and(eq(imageAnalysis.id, row.analysisId), eq(imageAnalysis.runId, input.runId)));

    if (status === "ANALYZED") summary.analyzed++;
    if (status === "CACHED") summary.cached++;
    if (status === "MALFORMED") summary.malformed++;
    if (status === "REFUSED") summary.refused++;
    summary.validationWarnings += warnings.length;
    summary.costUsd += cost;
    if (servedModel) served.add(servedModel);
    if (++done % 10 === 0) await ctx.heartbeat();
  });

  summary.servedModels = [...served].sort();
  summary.costUsd = Math.round(summary.costUsd * 1e6) / 1e6;

  await db
    .update(processingRuns)
    .set({
      visionProvider: provider.info.provider,
      visionModel: provider.info.model,
      visionModelVersion: provider.info.modelVersion,
      promptVersion: promptLabel(prompt),
      aiCostUsd: String(summary.costUsd),
    })
    .where(eq(processingRuns.id, input.runId));

  await recordAudit(db, {
    eventType: "AI_VISION_COMPLETED",
    actor: input.actor,
    locationId: input.locationId,
    runId: input.runId,
    data: {
      ...summary,
      provider: provider.info.provider,
      model: provider.info.model,
      modelVersion: provider.info.modelVersion,
      externalProvider: provider.info.external,
      prompt: promptLabel(prompt),
      services,
    },
  });

  if (summary.candidates > 0 && summary.analyzed + summary.cached === 0) {
    throw new WorkItemError(
      `Vision model produced no valid analysis for any of ${summary.candidates} images (malformed: ${summary.malformed}, refused: ${summary.refused})`,
      "MODEL_ERROR",
      "AI_ERROR",
    );
  }
  return summary;
}

/** Bounded JPEG copy for the model (handles HEIC via openImage). */
async function prepareForVision(bytes: Buffer, maxSide: number): Promise<Buffer> {
  const opened = await openImage(bytes, { maxInputPixels: 50_000_000 });
  return opened
    .image()
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}
