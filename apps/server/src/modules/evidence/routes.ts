import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { loadActiveConfig } from "../../config/configStore";
import {
  contradictions,
  evidence,
  evidenceBundleItems,
  imageAnalysis,
  imagePairs,
  images,
  locations,
  processingRuns,
  riskAssessments,
  serviceAssessments,
} from "../../db/schema";
import { band } from "../../domain/evidence";
import type { ValidatedPairComparison } from "../../domain/observations";
import { requireUser } from "../../http/authPlugin";
import type { AppContext } from "../../http/context";

const params = z.object({ id: z.string().uuid() });
const query = z.object({ runId: z.string().uuid().optional() });

/**
 * PRD §76 GET /api/locations/:id/evidence — per-service AI assessment for a run.
 * Raw model strengths and internal scores are NOT returned; only confidence bands
 * (PRD §24, §33).
 */
export async function evidenceRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/locations/:id/evidence", { preHandler: requireUser }, async (req, reply) => {
    const p = params.safeParse(req.params);
    const q = query.safeParse(req.query);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!q.success) return reply.code(400).send({ error: "INVALID_REQUEST" });

    const [loc] = await ctx.db.select({ currentRunId: locations.currentRunId }).from(locations).where(eq(locations.id, p.data.id));
    if (!loc) return reply.code(404).send({ error: "NOT_FOUND" });
    const runId = q.data.runId ?? loc.currentRunId;
    if (!runId) return { runId: null, services: [] };
    const [run] = await ctx.db
      .select({ id: processingRuns.id, runNumber: processingRuns.runNumber, status: processingRuns.status })
      .from(processingRuns)
      .where(and(eq(processingRuns.id, runId), eq(processingRuns.locationId, p.data.id)));
    if (!run) return reply.code(404).send({ error: "NOT_FOUND" });

    const config = await loadActiveConfig(ctx.db);
    const [assessments, items, conflicts, pairRows, bundleRows, [riskRow]] = await Promise.all([
      ctx.db.select().from(serviceAssessments).where(eq(serviceAssessments.runId, runId)).orderBy(asc(serviceAssessments.serviceCode)),
      ctx.db
        .select({
          serviceCode: evidence.serviceCode,
          role: evidence.role,
          imageId: evidence.imageId,
          ref: images.externalRef,
          evidenceType: evidence.evidenceType,
          strength: evidence.strength,
          observation: evidence.observation,
        })
        .from(evidence)
        .innerJoin(images, eq(images.id, evidence.imageId))
        .where(eq(evidence.runId, runId)),
      ctx.db.select().from(contradictions).where(eq(contradictions.runId, runId)),
      ctx.db.select().from(imagePairs).where(eq(imagePairs.runId, runId)),
      ctx.db
        .select({
          imageId: evidenceBundleItems.imageId,
          ref: images.externalRef,
          rank: evidenceBundleItems.rank,
          reasons: evidenceBundleItems.reasons,
          services: evidenceBundleItems.services,
        })
        .from(evidenceBundleItems)
        .innerJoin(images, eq(images.id, evidenceBundleItems.imageId))
        .where(eq(evidenceBundleItems.runId, runId))
        .orderBy(asc(evidenceBundleItems.rank)),
      ctx.db.select().from(riskAssessments).where(eq(riskAssessments.runId, runId)),
    ]);
    const riskDetail = riskRow?.factors as
      | { factors: { factor: string; detail: string }[]; recommendation: string; recommendationExplanation: string; lane: string }
      | undefined;
    const pairImageIds = [...new Set(pairRows.flatMap((p) => [p.beforeImageId, p.afterImageId]))];
    const pairRefs = new Map(
      pairImageIds.length
        ? (await ctx.db.select({ id: images.id, ref: images.externalRef }).from(images).where(inArray(images.id, pairImageIds))).map((r) => [r.id, r.ref])
        : [],
    );
    const refOf = new Map(items.map((i) => [i.imageId, i.ref]));

    return {
      runId,
      runNumber: run.runNumber,
      thresholdsProvisional: config.thresholds.provisional,
      /** AI suggestion only — a person makes every final decision. No internal score. */
      recommendation: riskDetail ? { value: riskDetail.recommendation, explanation: riskDetail.recommendationExplanation, lane: riskDetail.lane } : null,
      risk: riskRow ? { level: riskRow.level, factors: riskDetail!.factors.map((f) => ({ factor: f.factor, detail: f.detail })) } : null,
      /** Strongest evidence first (PRD §20): contradictions and counter-evidence are always included. */
      bundle: {
        totalImages: (await ctx.db.select({ id: imageAnalysis.id }).from(imageAnalysis).where(eq(imageAnalysis.runId, runId))).length,
        entries: bundleRows,
      },
      /** Before/after pairs evaluated for this run, confirmed first (PRD §24). */
      pairs: pairRows
        .map((p) => {
          const c = p.changeAnalysis as ValidatedPairComparison | null;
          return {
            id: p.id,
            status: p.status,
            beforeImageId: p.beforeImageId,
            beforeRef: pairRefs.get(p.beforeImageId) ?? null,
            afterImageId: p.afterImageId,
            afterRef: pairRefs.get(p.afterImageId) ?? null,
            sameAreaConfidence: c ? band(c.sameAreaConfidence, config.thresholds) : null,
            notes: c?.notes ?? null,
            changes: (c?.changes ?? []).map((ch) => ({
              service: ch.service,
              direction: ch.direction,
              strength: band(ch.strength, config.thresholds),
              description: ch.description,
            })),
          };
        })
        .sort((a, b) => Number(b.status === "CONFIRMED") - Number(a.status === "CONFIRMED") || (a.beforeRef ?? "").localeCompare(b.beforeRef ?? "")),
      services: assessments.map((a) => {
        const mine = items
          .filter((i) => i.serviceCode === a.serviceCode)
          .sort((x, y) => y.strength - x.strength)
          .map((i) => ({
            imageId: i.imageId,
            ref: i.ref,
            role: i.role,
            evidenceType: i.evidenceType,
            strength: band(i.strength, config.thresholds),
            observation: i.observation,
          }));
        return {
          service: a.serviceCode,
          displayName: config.registry.has(a.serviceCode) ? config.registry.get(a.serviceCode).display_name : a.serviceCode,
          status: a.status,
          confidence: a.confidenceLevel,
          humanRequired: a.humanRequired,
          reasons: a.reasons,
          explanation: a.explanation,
          components: a.components,
          /** This service's bundled images in reviewer order. */
          bundle: bundleRows
            .filter((b) => (b.services as { service: string }[]).some((s) => s.service === a.serviceCode))
            .map((b) => ({ imageId: b.imageId, ref: b.ref, roles: (b.services as { service: string; role: string }[]).filter((s) => s.service === a.serviceCode).map((s) => s.role) })),
          supporting: mine.filter((i) => i.role === "SUPPORTING"),
          contradicting: mine.filter((i) => i.role === "CONTRADICTING"),
          context: mine.filter((i) => i.role === "CONTEXT"),
          contradictions: conflicts
            .filter((c) => c.serviceCode === a.serviceCode)
            .map((c) => ({
              supportingImageId: c.supportingImageId,
              supportingRef: c.supportingImageId ? refOf.get(c.supportingImageId) ?? null : null,
              contradictingImageId: c.contradictingImageId,
              contradictingRef: c.contradictingImageId ? refOf.get(c.contradictingImageId) ?? null : null,
              description: c.description,
            })),
        };
      }),
    };
  });
}
