import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RISK_LEVELS } from "@alvip/shared";
import { loadActiveConfig } from "../../config/configStore";
import { requireRole } from "../../http/authPlugin";
import type { AppContext } from "../../http/context";
import { buildDashboard, dashboardScopes, localToday } from "../../services/dashboard";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const query = z.object({
  from: day.optional(),
  to: day.optional(),
  client: z.string().uuid().optional(),
  service: z.string().max(100).optional(),
  risk: z.enum(RISK_LEVELS).optional(),
  reviewer: z.string().uuid().optional(),
});
const MAX_DAYS = 366;

/** PRD §44 team lead dashboard. */
export async function dashboardRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/dashboard", { preHandler: requireRole("TEAM_LEAD") }, async (req, reply) => {
    const q = query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const today = localToday(ctx.env.METRICS_TIMEZONE);
    const to = q.data.to ?? q.data.from ?? today;
    const from = q.data.from ?? to;
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (!(days >= 0) || days >= MAX_DAYS) return reply.code(400).send({ error: "INVALID_RANGE", message: `Choose a range of 1 to ${MAX_DAYS} days.` });
    const config = await loadActiveConfig(ctx.db);
    return buildDashboard(
      ctx.db,
      {
        from,
        to,
        ...(q.data.client ? { clientId: q.data.client } : {}),
        ...(q.data.service ? { serviceCode: q.data.service } : {}),
        ...(q.data.risk ? { risk: q.data.risk } : {}),
        ...(q.data.reviewer ? { reviewerId: q.data.reviewer } : {}),
      },
      {
        timezone: ctx.env.METRICS_TIMEZONE,
        minSample: config.thresholds.metrics.min_sample_size,
        baselineReviewSeconds: ctx.env.METRICS_BASELINE_REVIEW_SECONDS ?? null,
      },
    );
  });

  app.get("/api/dashboard/scopes", { preHandler: requireRole("TEAM_LEAD") }, async () => dashboardScopes(ctx.db));
}
