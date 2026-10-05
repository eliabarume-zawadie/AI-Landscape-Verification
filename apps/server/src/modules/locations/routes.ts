import type { FastifyInstance, FastifyReply } from "fastify";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { AI_RECOMMENDATIONS, LANES, LOCATION_STATUSES, REPROCESS_REASONS, RISK_LEVELS } from "@alvip/shared";
import {
  auditEvents,
  clients,
  images,
  locations,
  locationServices,
  processingRuns,
  systemErrors,
  verificationJobs,
} from "../../db/schema";
import { InvalidTransitionError } from "../../domain/locationState";
import { requireRole, requireUser } from "../../http/authPlugin";
import type { AppContext } from "../../http/context";
import { JOB_TYPES } from "../../pipeline/jobTypes";
import { ingestQueue } from "../../services/ingest";
import { requestReprocess, routeToManualReview } from "../../services/locationActions";
import { LocationNotFoundError, StaleLocationStateError, transitionLocation } from "../../services/locationTransitions";

const idParam = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  status: z.enum(LOCATION_STATUSES).optional(),
  lane: z.enum(LANES).optional(),
  risk: z.enum(RISK_LEVELS).optional(),
  recommendation: z.enum(AI_RECOMMENDATIONS).optional(),
  client: z.string().optional(),
  service: z.string().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  runId: z.string().uuid().optional(),
  receivedFrom: z.coerce.date().optional(),
  receivedTo: z.coerce.date().optional(),
  /** Default oldest first (PRD §35); "risk" = highest risk first, then oldest. */
  sort: z.enum(["oldest", "newest", "risk"]).default("oldest"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const reprocessBody = z.object({
  reason: z.enum(REPROCESS_REASONS),
  note: z.string().max(2000).optional(),
});

const manualReviewBody = z.object({ note: z.string().max(2000).optional() });

export async function locationRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/locations", { preHandler: requireUser }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: parsed.error.issues });
    const f = parsed.data;

    const where: SQL[] = [];
    if (f.status) where.push(eq(locations.status, f.status));
    if (f.lane) where.push(eq(locations.lane, f.lane));
    if (f.risk) where.push(eq(locations.riskLevel, f.risk));
    if (f.recommendation) where.push(eq(locations.aiRecommendation, f.recommendation));
    if (f.client) where.push(eq(clients.code, f.client));
    if (f.receivedFrom) where.push(gte(locations.receivedAt, f.receivedFrom));
    if (f.receivedTo) where.push(lte(locations.receivedAt, f.receivedTo));
    if (f.q) where.push(or(ilike(locations.externalId, `%${f.q}%`), ilike(locations.name, `%${f.q}%`))!);
    if (f.service) {
      where.push(
        inArray(
          locations.id,
          ctx.db.select({ id: locationServices.locationId }).from(locationServices).where(eq(locationServices.serviceCode, f.service)),
        ),
      );
    }
    if (f.runId) {
      where.push(
        inArray(locations.id, ctx.db.select({ id: processingRuns.locationId }).from(processingRuns).where(eq(processingRuns.id, f.runId))),
      );
    }
    const condition = where.length > 0 ? and(...where) : undefined;

    const rows = await ctx.db
      .select({
        id: locations.id,
        externalId: locations.externalId,
        name: locations.name,
        client: clients.code,
        status: locations.status,
        lane: locations.lane,
        riskLevel: locations.riskLevel,
        aiRecommendation: locations.aiRecommendation,
        receivedAt: locations.receivedAt,
        statusChangedAt: locations.statusChangedAt,
        currentRunId: locations.currentRunId,
        services: sql<string[]>`coalesce((select array_agg(ls.service_code order by ls.service_code) from location_services ls where ls.location_id = ${locations.id}), '{}')`,
        imageCount: sql<number>`(select count(*)::int from images i where i.location_id = ${locations.id})`,
      })
      .from(locations)
      .innerJoin(clients, eq(clients.id, locations.clientId))
      .where(condition)
      .orderBy(
        ...(f.sort === "risk"
          ? [sql`case ${locations.riskLevel} when 'HIGH' then 0 when 'MEDIUM' then 1 when 'LOW' then 2 else 3 end`, asc(locations.receivedAt)]
          : [f.sort === "oldest" ? asc(locations.receivedAt) : desc(locations.receivedAt)]),
      )
      .limit(f.limit)
      .offset(f.offset);

    const [{ total } = { total: 0 }] = await ctx.db
      .select({ total: count() })
      .from(locations)
      .innerJoin(clients, eq(clients.id, locations.clientId))
      .where(condition);

    return { items: rows, total, limit: f.limit, offset: f.offset };
  });

  app.get("/api/locations/:id", { preHandler: requireUser }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    const id = p.data.id;

    const [loc] = await ctx.db
      .select({
        id: locations.id,
        externalId: locations.externalId,
        externalLocationRef: locations.externalLocationRef,
        name: locations.name,
        client: clients.code,
        clientName: clients.displayName,
        serviceDate: locations.serviceDate,
        status: locations.status,
        lane: locations.lane,
        riskLevel: locations.riskLevel,
        aiRecommendation: locations.aiRecommendation,
        priority: locations.priority,
        receivedAt: locations.receivedAt,
        statusChangedAt: locations.statusChangedAt,
        currentRunId: locations.currentRunId,
      })
      .from(locations)
      .innerJoin(clients, eq(clients.id, locations.clientId))
      .where(eq(locations.id, id));
    if (!loc) return reply.code(404).send({ error: "NOT_FOUND" });

    const [services, imgs, runs, audit, openErrors] = await Promise.all([
      ctx.db
        .select({ code: locationServices.serviceCode, source: locationServices.source })
        .from(locationServices)
        .where(eq(locationServices.locationId, id))
        .orderBy(asc(locationServices.serviceCode)),
      ctx.db
        .select({
          id: images.id,
          externalRef: images.externalRef,
          filename: images.filename,
          ordinal: images.ordinal,
          capturedAt: images.capturedAt,
          width: images.width,
          height: images.height,
          format: images.format,
          purgedAt: images.purgedAt,
        })
        .from(images)
        .where(eq(images.locationId, id))
        .orderBy(asc(images.ordinal), asc(images.externalRef)),
      ctx.db
        .select()
        .from(processingRuns)
        .where(eq(processingRuns.locationId, id))
        .orderBy(desc(processingRuns.runNumber)),
      ctx.db
        .select({
          id: auditEvents.id,
          occurredAt: auditEvents.occurredAt,
          eventType: auditEvents.eventType,
          actorType: auditEvents.actorType,
          actorId: auditEvents.actorId,
          runId: auditEvents.runId,
          data: auditEvents.data,
        })
        .from(auditEvents)
        .where(eq(auditEvents.locationId, id))
        .orderBy(asc(auditEvents.id)),
      ctx.db
        .select({
          id: systemErrors.id,
          category: systemErrors.category,
          source: systemErrors.source,
          message: systemErrors.message,
          occurredAt: systemErrors.occurredAt,
        })
        .from(systemErrors)
        .where(and(eq(systemErrors.locationId, id), isNull(systemErrors.resolvedAt)))
        .orderBy(desc(systemErrors.occurredAt)),
    ]);

    return { location: loc, services, images: imgs, runs, audit, openErrors };
  });

  app.post("/api/locations/:id/reprocess", { preHandler: requireRole("TEAM_LEAD") }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    const body = reprocessBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: body.error.issues });
    try {
      const { jobId } = await requestReprocess(ctx.db, ctx.queue, {
        locationId: p.data.id,
        reason: body.data.reason,
        ...(body.data.note ? { note: body.data.note } : {}),
        userId: req.user!.id,
        actor: { type: "USER", id: req.user!.id, ip: req.ip },
      });
      return reply.code(202).send({ jobId });
    } catch (err) {
      return sendStateError(reply, err);
    }
  });

  app.post("/api/locations/:id/manual-review", { preHandler: requireRole("TEAM_LEAD") }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    const body = manualReviewBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try {
      await routeToManualReview(ctx.db, {
        locationId: p.data.id,
        ...(body.data.note ? { note: body.data.note } : {}),
        actor: { type: "USER", id: req.user!.id, ip: req.ip },
      });
      return { ok: true };
    } catch (err) {
      return sendStateError(reply, err);
    }
  });

  /** PRD §76: start processing for a location that has not been queued yet. */
  app.post("/api/jobs/location/:id", { preHandler: requireRole("TEAM_LEAD") }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    try {
      const jobId = await ctx.db.transaction(async (tx) => {
        await transitionLocation(tx, {
          locationId: p.data.id,
          to: "QUEUED",
          expectedFrom: ["NEW"],
          actor: { type: "USER", id: req.user!.id, ip: req.ip },
          reason: "manually queued",
        });
        const { jobId } = await ctx.queue.enqueue(
          {
            type: JOB_TYPES.PROCESS_LOCATION,
            payload: { locationId: p.data.id, reason: "INITIAL", requestedBy: req.user!.id },
            idempotencyKey: `process:${p.data.id}:initial`,
            locationId: p.data.id,
          },
          tx,
        );
        return jobId;
      });
      return reply.code(202).send({ jobId });
    } catch (err) {
      return sendStateError(reply, err, "Use /api/locations/:id/reprocess for locations that were already processed.");
    }
  });

  app.get("/api/jobs/:id", { preHandler: requireRole("TEAM_LEAD") }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    const [job] = await ctx.db
      .select({
        id: verificationJobs.id,
        type: verificationJobs.type,
        status: verificationJobs.status,
        attempts: verificationJobs.attempts,
        maxAttempts: verificationJobs.maxAttempts,
        runAt: verificationJobs.runAt,
        lastError: verificationJobs.lastError,
        lastErrorCategory: verificationJobs.lastErrorCategory,
        locationId: verificationJobs.locationId,
        createdAt: verificationJobs.createdAt,
        completedAt: verificationJobs.completedAt,
      })
      .from(verificationJobs)
      .where(eq(verificationJobs.id, p.data.id));
    if (!job) return reply.code(404).send({ error: "NOT_FOUND" });
    return { job };
  });

  /** Counts by status and lane — the precursor of the Phase 12 dashboard. */
  app.get("/api/queue/summary", { preHandler: requireUser }, async () => {
    const [byStatus, byLane, byRisk, jobs, [oldest]] = await Promise.all([
      ctx.db.select({ status: locations.status, n: count() }).from(locations).groupBy(locations.status),
      ctx.db.select({ lane: locations.lane, n: count() }).from(locations).groupBy(locations.lane),
      ctx.db
        .select({ risk: locations.riskLevel, n: count() })
        .from(locations)
        .where(inArray(locations.status, ["HUMAN_REVIEW", "AI_REVIEW_READY", "ESCALATED"]))
        .groupBy(locations.riskLevel),
      ctx.db.select({ status: verificationJobs.status, n: count() }).from(verificationJobs).groupBy(verificationJobs.status),
      ctx.db
        .select({ receivedAt: sql<Date | null>`min(${locations.receivedAt})` })
        .from(locations)
        .where(inArray(locations.status, ["NEW", "QUEUED", "DOWNLOADING", "ANALYZING", "EVIDENCE_BUILDING"])),
    ]);
    return {
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      byLane: Object.fromEntries(byLane.map((r) => [r.lane ?? "NONE", r.n])),
      /** Awaiting review, by risk (NONE = no AI assessment, e.g. manual fallback). */
      awaitingReviewByRisk: Object.fromEntries(byRisk.map((r) => [r.risk ?? "NONE", r.n])),
      jobs: Object.fromEntries(jobs.map((r) => [r.status, r.n])),
      oldestUnprocessedReceivedAt: oldest?.receivedAt ?? null,
    };
  });

  /** Pull the NetSuite queue now (otherwise the worker polls on a schedule). */
  app.post("/api/admin/ingest", { preHandler: requireRole("TEAM_LEAD") }, async (req) => {
    const summary = await ingestQueue({
      db: ctx.db,
      netsuite: ctx.integrations.netsuite,
      queue: ctx.queue,
      actor: { type: "USER", id: req.user!.id, ip: req.ip },
    });
    return { summary };
  });
}

function sendStateError(reply: FastifyReply, err: unknown, hint?: string) {
  if (err instanceof LocationNotFoundError) return reply.code(404).send({ error: "NOT_FOUND" });
  if (err instanceof StaleLocationStateError) {
    return reply.code(409).send({ error: "INVALID_STATE", status: err.actual, allowedFrom: err.expected, ...(hint ? { hint } : {}) });
  }
  if (err instanceof InvalidTransitionError) {
    return reply.code(409).send({ error: "INVALID_STATE", status: err.from, ...(hint ? { hint } : {}) });
  }
  throw err;
}
