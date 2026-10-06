import { existsSync } from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { adminRoutes } from "../modules/admin/routes";
import { authRoutes } from "../modules/auth/routes";
import { configRoutes } from "../modules/config/routes";
import { evidenceRoutes } from "../modules/evidence/routes";
import { imageRoutes } from "../modules/images/routes";
import { locationRoutes } from "../modules/locations/routes";
import { reviewRoutes } from "../modules/reviews/routes";
import { knowledgeRoutes } from "../modules/knowledge/routes";
import { feedbackRoutes } from "../modules/feedback/routes";
import { netsuiteRoutes } from "../modules/netsuite/routes";
import { dashboardRoutes } from "../modules/dashboard/routes";
import { evaluationRoutes } from "../modules/evaluation/routes";
import { shadowRoutes } from "../modules/shadow/routes";
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
  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    const isAsset = req.url.startsWith("/assets/");
    if (!isAsset) reply.header("Cache-Control", "no-store"); // API data and HTML are never cached
    if (!req.url.startsWith("/api/")) {
      // The UI loads only its own scripts, styles, fonts and images.
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    }
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
  await imageRoutes(app, ctx);
  await evidenceRoutes(app, ctx);
  await reviewRoutes(app, ctx);
  await knowledgeRoutes(app, ctx);
  await feedbackRoutes(app, ctx);
  await netsuiteRoutes(app, ctx);
  await dashboardRoutes(app, ctx);
  await evaluationRoutes(app, ctx);
  await shadowRoutes(app, ctx);

  // Reviewer UI (single deployable): static assets + SPA fallback for client-side routes.
  if (existsSync(path.join(ctx.env.WEB_DIST_DIR, "index.html"))) {
    await app.register(fastifyStatic, {
      root: ctx.env.WEB_DIST_DIR,
      // Look files up per request, so a redeployed dist/ is served without a restart.
      wildcard: true,
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) res.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      // Client-side routes get the app shell; missing API routes and asset files are real 404s
      // (serving HTML for a missing script would make the browser reject it silently).
      if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/assets/")) {
        return reply.type("text/html").sendFile("index.html");
      }
      return reply.code(404).send({ error: "NOT_FOUND" });
    });
  }

  return app;
}
