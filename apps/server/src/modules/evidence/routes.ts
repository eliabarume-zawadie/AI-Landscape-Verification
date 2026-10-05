import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { loadActiveConfig } from "../../config/configStore";
import { contradictions, evidence, images, locations, processingRuns, serviceAssessments } from "../../db/schema";
import { band } from "../../domain/evidence";
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
    const [assessments, items, conflicts] = await Promise.all([
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
    ]);
    const refOf = new Map(items.map((i) => [i.imageId, i.ref]));

    return {
      runId,
      runNumber: run.runNumber,
      thresholdsProvisional: config.thresholds.provisional,
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
