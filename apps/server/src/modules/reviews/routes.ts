import type { FastifyInstance, FastifyReply } from "fastify";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { OVERRIDE_REASON_CODES, REVIEW_DECISIONS } from "@alvip/shared";
import { users } from "../../db/schema";
import { InvalidTransitionError } from "../../domain/locationState";
import { requireRole, requireUser } from "../../http/authPlugin";
import type { AppContext } from "../../http/context";
import { LocationNotFoundError, StaleLocationStateError } from "../../services/locationTransitions";
import { confirmFastLane, nextLocation, openReview, reviewHistory, ReviewValidationError, submitReview } from "../../services/review";

const idParam = z.object({ id: z.string().uuid() });
const reviewBody = z.object({
  decision: z.enum(REVIEW_DECISIONS),
  serviceDecisions: z.record(z.string(), z.enum(["APPROVE", "REJECT"])).optional(),
  reasonCode: z.enum(OVERRIDE_REASON_CODES).optional(),
  reasonText: z.string().max(2000).optional(),
  evidenceViewed: z.array(z.string().uuid()).max(500).optional(),
  openedAt: z.coerce.date().optional(),
});
const nextQuery = z.object({ lane: z.enum(["HUMAN_REVIEW", "FAST"]).optional(), after: z.string().uuid().optional() });
const batchBody = z.object({ locationIds: z.array(z.string().uuid()).min(1).max(50), openedAt: z.coerce.date().optional() });

export async function reviewRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Next location to review, oldest first (PRD §35). */
  app.get("/api/review/next", { preHandler: requireUser }, async (req, reply) => {
    const q = nextQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const id = await nextLocation(ctx.db, req.user!.role, {
      ...(q.data.lane ? { lane: q.data.lane } : {}),
      ...(q.data.after ? { excludeId: q.data.after } : {}),
    });
    return { locationId: id };
  });

  app.post("/api/locations/:id/review/open", { preHandler: requireUser }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    try {
      const openedAt = await openReview(ctx.db, { ...req.user!, ip: req.ip }, p.data.id);
      return { openedAt };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** PRD §76: record the human decision. */
  app.post("/api/locations/:id/review", { preHandler: requireUser }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    const body = reviewBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: body.error.issues });
    try {
      const r = await submitReview(ctx.db, { ...req.user!, ip: req.ip }, { locationId: p.data.id, ...stripUndefined(body.data) });
      return reply.code(201).send({ reviewId: r.review.id, status: r.status, isOverride: r.review.isOverride, conflicts: r.conflicts });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/locations/:id/reviews", { preHandler: requireUser }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    const rows = await reviewHistory(ctx.db, p.data.id);
    const names = rows.length
      ? new Map(
          (await ctx.db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, [...new Set(rows.map((r) => r.reviewerId))]))).map(
            (u) => [u.id, u.name],
          ),
        )
      : new Map<string, string>();
    return { reviews: rows.map((r) => ({ ...r, reviewerName: names.get(r.reviewerId) ?? null })) };
  });

  /** Fast Lane batch confirmation (automation level 3 only; still a human decision per location). */
  app.post("/api/review/fast-lane/confirm", { preHandler: requireRole("REVIEWER") }, async (req, reply) => {
    if (ctx.env.AUTOMATION_LEVEL < 3) return reply.code(409).send({ error: "FAST_LANE_DISABLED" });
    const body = batchBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try {
      const r = await confirmFastLane(ctx.db, { ...req.user!, ip: req.ip }, body.data.locationIds, body.data.openedAt);
      return { confirmed: r.length };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof LocationNotFoundError) return reply.code(404).send({ error: "NOT_FOUND" });
  if (err instanceof ReviewValidationError) {
    const status = err.code === "FORBIDDEN" ? 403 : 422;
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  if (err instanceof StaleLocationStateError || err instanceof InvalidTransitionError) {
    // Someone else decided first, or the location is no longer awaiting review.
    return reply.code(409).send({ error: "INVALID_STATE", message: err.message });
  }
  throw err;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

