import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { OVERRIDE_REASON_CODES } from "@alvip/shared";
import { recordAudit } from "../../audit/audit";
import { requireRole } from "../../http/authPlugin";
import type { AppContext } from "../../http/context";
import { feedbackCsv, listFeedback, summarizeFeedback, type FeedbackFilter } from "../../services/feedbackReport";

const filterQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  reason: z.enum(OVERRIDE_REASON_CODES).optional(),
  service: z.string().max(100).optional(),
  reviewer: z.string().uuid().optional(),
  overridesOnly: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const EXPORT_MAX_ROWS = 50_000;

function toFilter(q: z.infer<typeof filterQuery>): FeedbackFilter {
  return {
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
    ...(q.reason ? { reasonCode: q.reason } : {}),
    ...(q.service ? { serviceCode: q.service } : {}),
    ...(q.reviewer ? { reviewerId: q.reviewer } : {}),
    overridesOnly: q.overridesOnly === "true",
  };
}

/** PRD §30 reviewer feedback, for team leads. */
export async function feedbackRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/feedback", { preHandler: requireRole("TEAM_LEAD") }, async (req, reply) => {
    const q = filterQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const f = toFilter(q.data);
    const [rows, summary] = await Promise.all([listFeedback(ctx.db, f, { limit: q.data.limit, offset: q.data.offset }), summarizeFeedback(ctx.db, f)]);
    return { rows, summary };
  });

  /** CSV for evaluation work. Exports contain reviewer notes, so each one is audited. */
  app.get("/api/feedback/export.csv", { preHandler: requireRole("TEAM_LEAD") }, async (req, reply) => {
    const q = filterQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const f = toFilter(q.data);
    const rows = await listFeedback(ctx.db, f, { limit: EXPORT_MAX_ROWS, offset: 0 });
    await recordAudit(ctx.db, {
      eventType: "FEEDBACK_EXPORTED",
      actor: { type: "USER", id: req.user!.id, ip: req.ip },
      entityType: "feedback",
      data: { filter: { ...f, from: f.from?.toISOString(), to: f.to?.toISOString() }, rows: rows.length, truncated: rows.length === EXPORT_MAX_ROWS },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="alvip-feedback-${stamp}.csv"`)
      .send(feedbackCsv(rows));
  });
}
