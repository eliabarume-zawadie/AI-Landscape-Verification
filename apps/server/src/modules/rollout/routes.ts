import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { ROLLOUT_MODES } from "@alvip/shared";
import { requireRole } from "../../http/authPlugin";
import type { AppContext } from "../../http/context";
import { completeQc, listQc, QcError, qcStats } from "../../services/qc";
import { listRollout, minSample, RolloutError, rolloutHistory, setRollout } from "../../services/rollout";

const changeBody = z.object({
  clientId: z.string().uuid().nullable(),
  mode: z.enum(ROLLOUT_MODES),
  fastTrackServices: z.array(z.string().max(100)).max(50).optional(),
  reason: z.string().trim().min(1).max(2000),
  evaluationRunId: z.string().uuid().optional(),
  acknowledgeNoValidation: z.boolean().optional(),
});
const qcBody = z.object({
  verdict: z.enum(["CONFIRMED", "DISAGREE"]),
  correctDecision: z.enum(["APPROVE", "REJECT"]).optional(),
  note: z.string().max(2000).optional(),
});

/** PRD §71 / §90 controlled rollout and QC sampling. */
export async function rolloutRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/rollout", { preHandler: requireRole("TEAM_LEAD") }, async () => ({
    ...(await listRollout(ctx.db, ctx.env)),
    qc: await qcStats(ctx.db, await minSample(ctx.db)),
    qcRates: { fastLane: ctx.env.QC_SAMPLE_RATE_FAST_LANE, approvals: ctx.env.QC_SAMPLE_RATE_APPROVALS },
  }));

  app.get("/api/rollout/history", { preHandler: requireRole("TEAM_LEAD") }, async (req, reply) => {
    const q = z.object({ client: z.string().uuid().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    return { history: await rolloutHistory(ctx.db, q.data.client ?? null) };
  });

  /** Changing how much the AI is used is an admin decision, recorded with its reason. */
  app.post("/api/rollout", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    const b = changeBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: b.error.issues });
    try {
      const r = await setRollout(ctx.db, ctx.env, { type: "USER", id: req.user!.id, ip: req.ip }, Object.fromEntries(Object.entries(b.data).filter(([, v]) => v !== undefined)) as typeof b.data);
      return reply.code(201).send({ id: r.setting.id, effective: r.effective, movedOutOfFastLane: r.movedOutOfFastLane });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/qc", { preHandler: requireRole("TEAM_LEAD") }, async (req, reply) => {
    const q = z.object({ status: z.enum(["PENDING", "DONE"]).optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    return { samples: await listQc(ctx.db, q.data.status), stats: await qcStats(ctx.db, await minSample(ctx.db)) };
  });

  app.post("/api/qc/:id", { preHandler: requireRole("TEAM_LEAD") }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const b = qcBody.safeParse(req.body);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!b.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try {
      await completeQc(ctx.db, { type: "USER", id: req.user!.id, ip: req.ip }, p.data.id, Object.fromEntries(Object.entries(b.data).filter(([, v]) => v !== undefined)) as typeof b.data);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof RolloutError) {
    const status = { INVALID: 422, ABOVE_CEILING: 409, VALIDATION_REQUIRED: 428 }[err.code];
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  if (err instanceof QcError) {
    const status = { NOT_FOUND: 404, FORBIDDEN: 403, STATE: 409, INVALID: 422 }[err.code];
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  throw err;
}
