import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { ClientProfile } from "@alvip/shared";
import { recordAudit, type Actor } from "../../audit/audit";
import type { ActiveConfig } from "../../config/configStore";
import { imageAnalysis, imagePairs, images, processingRuns, visionCache } from "../../db/schema";
import { deriveStageInputs, isConfirmedPair, type EvaluatedPair } from "../../domain/beforeAfter";
import type { StageInputs } from "../../domain/evidence";
import {
  areaCheckJsonSchema,
  pairComparisonJsonSchema,
  validateAreaCheck,
  validatePairComparison,
  type ValidatedAreaCheck,
  type ValidatedPairComparison,
} from "../../domain/observations";
import { pairCandidates, type PairableImage } from "../../domain/pairing";
import { classifyStages } from "../../domain/stageClassification";
import {
  BEFORE_AFTER_PROMPT,
  loadPrompt,
  promptLabel,
  registerPrompt,
  renderPairComparisonPrompt,
  SAME_AREA_PROMPT,
} from "../../integrations/vision/prompts";
import type { ProviderResponse } from "../../integrations/vision/VisionProvider";
import type { JobContext } from "../jobHandler";
import { mapLimit } from "../mapLimit";
import { loadEvidenceImages } from "./evidenceStage";
import { prepareForVision } from "./visionStage";

export type PairStatus = "CONFIRMED" | "NOT_SAME_AREA" | "NOT_COMPARABLE" | "LOW_CONFIDENCE" | "MALFORMED" | "REFUSED";

export interface PairStageSummary {
  stages: Record<string, number>;
  befores: number;
  afters: number;
  candidates: number;
  compared: number;
  cached: number;
  confirmed: number;
  byStatus: Record<string, number>;
  callCapReached: boolean;
  costUsd: number;
  established: string[];
  /** Verified distinct areas, counted only up to the client's requirement. */
  distinctAreas: number;
  areaChecks: { a: string; b: string; result: "DIFFERENT" | "SAME_OR_UNSURE" }[];
}

/**
 * PRD §18–19: before/after pairing and comparison.
 * Stages come from metadata only; candidates are visual shortlists; a pair counts only
 * when the vision model confirms the same area. For each before-photo, candidates are
 * tried best-first until one is confirmed. Distinct areas are credited only when the
 * model confirms two confirmed pairs show different areas, up to the client's minimum.
 * All calls (pairs + area checks) share a per-location cap.
 */
export async function runPairStage(
  ctx: JobContext,
  input: { locationId: string; runId: string; services: string[]; config: ActiveConfig; profile: ClientProfile; actor: Actor },
): Promise<{ stageInputs: Required<StageInputs>; summary: PairStageSummary }> {
  const { db, env } = ctx;
  const t = input.config.thresholds;
  const provider = ctx.integrations.vision;
  const services = [...input.services].sort();

  const rows = await db
    .select({
      analysisId: imageAnalysis.id,
      imageId: images.id,
      ref: images.externalRef,
      filename: images.filename,
      capturedAt: images.capturedAt,
      sha256: images.sha256,
      storageKey: images.storageKey,
      fingerprint: images.fingerprint,
      colorHist: images.colorHist,
    })
    .from(imageAnalysis)
    .innerJoin(images, eq(images.id, imageAnalysis.imageId))
    .where(eq(imageAnalysis.runId, input.runId))
    .orderBy(asc(images.ordinal), asc(images.externalRef));

  // 1. Stage from metadata only.
  const stages = classifyStages(
    rows.map((r) => ({ imageId: r.imageId, filename: r.filename, capturedAt: r.capturedAt })),
    t.pairing,
  );
  for (const r of rows) {
    const s = stages.get(r.imageId)!;
    await db
      .update(imageAnalysis)
      .set({ stage: s.stage, stageCertainty: s.certainty, stageSignals: s.signals })
      .where(eq(imageAnalysis.id, r.analysisId));
  }

  // 2. Candidates among eligible (analysed, usable, representative) images.
  const evidenceImages = await loadEvidenceImages(ctx, input.runId);
  const eligible = new Set(
    evidenceImages
      .filter((i) => i.usable && i.isRepresentative && (i.analysisStatus === "ANALYZED" || i.analysisStatus === "CACHED"))
      .map((i) => i.imageId),
  );
  const pairable = (r: (typeof rows)[number]): PairableImage => ({
    imageId: r.imageId,
    ref: r.ref,
    fingerprint: r.fingerprint ? new Uint8Array(Buffer.from(r.fingerprint, "base64")) : null,
    colorHist: r.colorHist ? new Uint8Array(Buffer.from(r.colorHist, "base64")) : null,
  });
  const befores = rows.filter((r) => eligible.has(r.imageId) && stages.get(r.imageId)!.stage === "BEFORE").map(pairable);
  const afters = rows.filter((r) => eligible.has(r.imageId) && stages.get(r.imageId)!.stage === "AFTER").map(pairable);
  const candidates = pairCandidates(befores, afters, t.pairing);
  const rowById = new Map(rows.map((r) => [r.imageId, r]));

  // 3. Compare, best candidate first per before-photo, under a per-location cap.
  const prompt = loadPrompt(env.PROMPTS_DIR, BEFORE_AFTER_PROMPT);
  await registerPrompt(db, prompt);
  const rendered = renderPairComparisonPrompt(prompt, services.map((s) => input.config.registry.get(s)));
  const schema = pairComparisonJsonSchema(services);
  const settingsKey = JSON.stringify({
    kind: "pair",
    prompt: prompt.contentHash,
    provider: provider.info.provider,
    model: provider.info.model,
    modelVersion: provider.info.modelVersion,
    services,
    maxSide: env.VISION_MAX_IMAGE_SIDE,
  });

  // Budget: reserve calls for the distinct-area checks (≤ required² for `required` areas).
  const required = Math.max(1, input.profile.image_requirements.min_distinct_scenes ?? 1);
  const pairBudget = Math.max(1, t.pairing.max_pair_calls - (required > 1 ? required * required : 0));
  let calls = 0;
  let callCapReached = false;
  let cached = 0;
  let costUsd = 0;
  const evaluated: EvaluatedPair[] = [];
  const byStatus: Record<string, number> = {};
  const preparedCache = new Map<string, Promise<Buffer>>();
  const prepared = (imageId: string) => {
    if (!preparedCache.has(imageId)) {
      preparedCache.set(
        imageId,
        (async () => {
          const r = rowById.get(imageId)!;
          const bytes = r.storageKey ? await ctx.integrations.storage.get(r.storageKey) : null;
          if (!bytes) throw new Error(`Image ${imageId} bytes missing from storage`);
          return prepareForVision(bytes, env.VISION_MAX_IMAGE_SIDE);
        })(),
      );
    }
    return preparedCache.get(imageId)!;
  };

  const byBefore = new Map<string, typeof candidates>();
  for (const c of candidates) byBefore.set(c.beforeId, [...(byBefore.get(c.beforeId) ?? []), c]);

  await mapLimit([...byBefore.values()], env.VISION_CONCURRENCY, async (list) => {
    for (const c of list) {
      const b = rowById.get(c.beforeId)!;
      const a = rowById.get(c.afterId)!;
      const cacheKey = createHash("sha256").update(`${b.sha256}|${a.sha256}|${settingsKey}`).digest("hex");
      const [hit] = await db.select().from(visionCache).where(eq(visionCache.cacheKey, cacheKey));

      let comparison: ValidatedPairComparison | null = null;
      let status: PairStatus;
      let raw: unknown = null;
      let validationError: string | null = null;
      let servedModel: string | null = null;
      let cost = 0;

      if (hit) {
        cached++;
        comparison = hit.result as ValidatedPairComparison;
        servedModel = hit.servedModel;
      } else {
        if (calls >= pairBudget) {
          callCapReached = true;
          return;
        }
        calls++;
        const req = {
          before: { imageId: b.imageId, externalRef: b.ref, bytes: await prepared(b.imageId), mediaType: "image/jpeg" as const },
          after: { imageId: a.imageId, externalRef: a.ref, bytes: await prepared(a.imageId), mediaType: "image/jpeg" as const },
          services,
          prompt: rendered,
          promptLabel: promptLabel(prompt),
          outputSchema: schema,
        };
        let resp: ProviderResponse = await provider.comparePair(req);
        let check = resp.refused ? null : validatePairComparison(resp.output, { requestedServices: services });
        cost += resp.usage.costUsd ?? 0;
        if (check && !check.ok) {
          resp = await provider.comparePair(req);
          check = resp.refused ? null : validatePairComparison(resp.output, { requestedServices: services });
          cost += resp.usage.costUsd ?? 0;
        }
        raw = resp.refused ? { refused: resp.refused } : resp.output;
        servedModel = resp.servedModel;
        if (check && check.ok) {
          comparison = check.value;
          await db
            .insert(visionCache)
            .values({ cacheKey, sha256: `${b.sha256}|${a.sha256}`, result: comparison, servedModel, costUsd: String(cost) })
            .onConflictDoNothing();
        } else if (check && !check.ok) {
          validationError = check.error;
        }
      }
      costUsd += cost;

      const pair: EvaluatedPair = { pairId: "", beforeId: b.imageId, afterId: a.imageId, comparison };
      status = !comparison
        ? raw && typeof raw === "object" && "refused" in raw
          ? "REFUSED"
          : "MALFORMED"
        : !comparison.sameArea
          ? "NOT_SAME_AREA"
          : !comparison.comparisonPossible
            ? "NOT_COMPARABLE"
            : isConfirmedPair(pair, t.pairing)
              ? "CONFIRMED"
              : "LOW_CONFIDENCE";
      byStatus[status] = (byStatus[status] ?? 0) + 1;

      const [stored] = await db
        .insert(imagePairs)
        .values({
          runId: input.runId,
          beforeImageId: b.imageId,
          afterImageId: a.imageId,
          pairingScore: c.distance,
          pairingSignals: {
            rank: c.rank,
            distance: c.distance,
            beforeStage: stages.get(b.imageId),
            afterStage: stages.get(a.imageId),
          },
          changeAnalysis: comparison,
          status,
          rawResponse: raw === null ? null : typeof raw === "string" ? { text: raw.slice(0, 4000) } : raw,
          validationError,
          servedModel,
          cacheHit: Boolean(hit),
          costUsd: String(cost),
        })
        .onConflictDoNothing()
        .returning({ id: imagePairs.id });
      evaluated.push({ ...pair, pairId: stored?.id ?? "" });
      if (status === "CONFIRMED") return; // this before-photo is paired; stop spending on it
    }
  });

  // 4. Distinct areas: verified positively by the model, never estimated (see beforeAfter.ts).
  const areaPrompt = loadPrompt(env.PROMPTS_DIR, SAME_AREA_PROMPT);
  await registerPrompt(db, areaPrompt);
  const areaChecks: { a: string; b: string; result: "DIFFERENT" | "SAME_OR_UNSURE" }[] = [];

  /** DIFFERENT only when the model is confident the landmarks differ; anything else is unsure. */
  const differentAreas = async (x: string, y: string): Promise<boolean> => {
    const [first, second] = [rowById.get(x)!, rowById.get(y)!].sort((m, n) => (m.sha256 ?? "").localeCompare(n.sha256 ?? ""));
    const key = createHash("sha256")
      .update(`area|${first!.sha256}|${second!.sha256}|${areaPrompt.contentHash}|${provider.info.provider}|${provider.info.model}|${provider.info.modelVersion}`)
      .digest("hex");
    const [hit] = await db.select().from(visionCache).where(eq(visionCache.cacheKey, key));
    let check = hit ? (hit.result as ValidatedAreaCheck) : null;
    if (!hit) {
      if (calls >= t.pairing.max_pair_calls) {
        callCapReached = true;
        return false;
      }
      calls++;
      const req = {
        before: { imageId: first!.imageId, externalRef: first!.ref, bytes: await prepared(first!.imageId), mediaType: "image/jpeg" as const },
        after: { imageId: second!.imageId, externalRef: second!.ref, bytes: await prepared(second!.imageId), mediaType: "image/jpeg" as const },
        labels: ["PHOTO A", "PHOTO B"] as [string, string],
        services: [],
        prompt: areaPrompt.template,
        promptLabel: promptLabel(areaPrompt),
        outputSchema: areaCheckJsonSchema(),
      };
      for (let attempt = 0; attempt < 2 && !check; attempt++) {
        const resp = await provider.comparePair(req);
        costUsd += resp.usage.costUsd ?? 0;
        if (resp.refused) break;
        const v = validateAreaCheck(resp.output);
        if (v.ok) {
          check = v.value;
          await db
            .insert(visionCache)
            .values({ cacheKey: key, sha256: `${first!.sha256}|${second!.sha256}`, result: check, servedModel: resp.servedModel, costUsd: String(resp.usage.costUsd ?? 0) })
            .onConflictDoNothing();
        }
      }
    }
    const different = !!check && !check.sameArea && check.confidence >= t.pairing.min_same_area_confidence;
    areaChecks.push({ a: first!.ref, b: second!.ref, result: different ? "DIFFERENT" : "SAME_OR_UNSURE" });
    return different;
  };

  const distinctPairs: EvaluatedPair[] = [];
  for (const p of evaluated.filter((e) => isConfirmedPair(e, t.pairing))) {
    if (distinctPairs.length >= required) break;
    let distinct = true;
    for (const s of distinctPairs) {
      if (!(await differentAreas(s.afterId, p.afterId))) {
        distinct = false;
        break;
      }
    }
    if (distinct) distinctPairs.push(p);
  }

  // 5. Engine inputs.
  const stageInputs = deriveStageInputs({
    images: evidenceImages,
    stages,
    pairs: evaluated,
    services,
    registry: input.config.registry,
    profile: input.profile,
    thresholds: t,
    verifiedDistinctAreas: distinctPairs.length,
  });

  const stageCounts: Record<string, number> = {};
  for (const s of stages.values()) stageCounts[s.stage] = (stageCounts[s.stage] ?? 0) + 1;
  const summary: PairStageSummary = {
    stages: stageCounts,
    befores: befores.length,
    afters: afters.length,
    candidates: candidates.length,
    compared: calls,
    cached,
    confirmed: evaluated.filter((p) => isConfirmedPair(p, t.pairing)).length,
    byStatus,
    callCapReached,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    established: [...stageInputs.beforeAfterEstablished].sort(),
    distinctAreas: stageInputs.distinctScenes,
    areaChecks,
  };

  if (summary.costUsd > 0) {
    const [run] = await db.select({ cost: processingRuns.aiCostUsd }).from(processingRuns).where(eq(processingRuns.id, input.runId));
    await db
      .update(processingRuns)
      .set({ aiCostUsd: String(Number(run?.cost ?? 0) + summary.costUsd) })
      .where(eq(processingRuns.id, input.runId));
  }
  await recordAudit(db, {
    eventType: "BEFORE_AFTER_COMPLETED",
    actor: input.actor,
    locationId: input.locationId,
    runId: input.runId,
    data: { ...summary, prompt: promptLabel(prompt), pairingThresholdsVersion: t.version },
  });
  return { stageInputs, summary };
}

