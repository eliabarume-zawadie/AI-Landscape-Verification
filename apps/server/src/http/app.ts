import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { adminRoutes } from "../modules/admin/routes";
import { authRoutes } from "../modules/auth/routes";
import { configRoutes } from "../modules/config/routes";
import { locationRoutes } from "../modules/locations/routes";
import { registerAuth } from "./authPlugin";
import type { AppContext } from "./context";

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      ctx.env.LOG_LEVEL === "silent"
        ? false
        : {
            level: ctx.env.LOG_LEVEL,
            // Never log credentials or session cookies.
            redact: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'],
          },
    trustProxy: ctx.env.NODE_ENV === "production",
    bodyLimit: 1_048_576,
  });

  await app.register(cookie);
  await registerAuth(app, ctx);

  // Baseline security headers (HTTPS is terminated upstream; see docs/SECURITY.md).
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    if (ctx.env.NODE_ENV === "production") {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });

  app.setErrorHandler((err: { statusCode?: number; code?: string }, req, reply) => {
    req.log.error({ err }, "request failed");
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    // Don't leak internals on 5xx.
    reply.code(status).send({ error: status === 500 ? "INTERNAL_ERROR" : (err.code ?? "REQUEST_ERROR") });
  });

  app.get("/api/health", async (_req, reply) => {
    try {
      await ctx.db.execute(sql`select 1`);
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "degraded" });
    }
  });

  await authRoutes(app, ctx);
  await configRoutes(app, ctx);
  await adminRoutes(app, ctx);
  await locationRoutes(app, ctx);

  return app;
}
