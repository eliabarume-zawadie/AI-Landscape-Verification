import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole, requireUser } from "../../http/authPlugin";
import type { AppContext } from "../../http/context";
import { LocationNotFoundError, StaleLocationStateError } from "../../services/locationTransitions";
import { outboxForLocation, retryNetSuiteSync } from "../../services/netsuiteSync";

const idParam = z.object({ id: z.string().uuid() });

/** NetSuite write-back status per location (PRD §37–39). */
export async function netsuiteRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/locations/:id/netsuite", { preHandler: requireUser }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    return { writes: await outboxForLocation(ctx.db, p.data.id) };
  });

  /** After fixing the cause of a NETSUITE_ERROR (credentials, NetSuite record, outage). */
  app.post("/api/locations/:id/netsuite/retry", { preHandler: requireRole("TEAM_LEAD") }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    try {
      const r = await retryNetSuiteSync(ctx.db, ctx.queue, { type: "USER", id: req.user!.id, ip: req.ip }, p.data.id, {
        maxAttempts: ctx.env.NETSUITE_SYNC_MAX_ATTEMPTS,
      });
      return reply.code(202).send(r);
    } catch (err) {
      if (err instanceof LocationNotFoundError) return reply.code(404).send({ error: "NOT_FOUND" });
      if (err instanceof StaleLocationStateError) {
        return reply.code(409).send({ error: "INVALID_STATE", message: "Only locations with a NetSuite problem can be retried." });
      }
      throw err;
    }
  });
}
