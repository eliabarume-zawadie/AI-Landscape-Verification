import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadActiveConfig } from "../../config/configStore";
import { requireRole } from "../../http/authPlugin";
import type { AppContext } from "../../http/context";
import { bounds, localToday } from "../../services/dashboard";
import { shadowReport } from "../../services/shadow";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const query = z.object({ from: day.optional(), to: day.optional(), client: z.string().uuid().optional() });

/** PRD §89 shadow-mode results, for team leads. */
export async function shadowRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/shadow", { preHandler: requireRole("TEAM_LEAD") }, async (req, reply) => {
    const q = query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const to = q.data.to ?? localToday(ctx.env.METRICS_TIMEZONE);
    const from = q.data.from ?? to;
    if (!(Date.parse(to) >= Date.parse(from))) return reply.code(400).send({ error: "INVALID_RANGE" });
    const { start, end } = await bounds(ctx.db, { from, to }, ctx.env.METRICS_TIMEZONE);
    const config = await loadActiveConfig(ctx.db);
    const report = await shadowReport(ctx.db, { start, end, ...(q.data.client ? { clientId: q.data.client } : {}) }, config.thresholds.metrics.min_sample_size);
    return { enabled: ctx.env.SHADOW_MODE, automationLevel: ctx.env.AUTOMATION_LEVEL, period: { from, to, timezone: ctx.env.METRICS_TIMEZONE }, ...report };
  });
}
