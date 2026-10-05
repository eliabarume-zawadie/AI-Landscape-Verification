import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser, SESSION_COOKIE } from "../../http/authPlugin";
import type { AppContext } from "../../http/context";
import { login, logout } from "../../services/auth";

const loginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
});

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post("/api/auth/login", async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });

    const result = await login(ctx.db, ctx.loginThrottle, {
      ...parsed.data,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      ttlHours: ctx.env.SESSION_TTL_HOURS,
    });
    if (!result.ok) {
      // Same message for unknown user / wrong password / inactive to avoid account enumeration.
      const code = result.reason === "THROTTLED" ? 429 : 401;
      return reply.code(code).send({ error: result.reason });
    }

    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      secure: ctx.env.COOKIE_SECURE,
      sameSite: "strict",
      path: "/",
      expires: result.expiresAt,
    });
    return { user: result.user };
  });

  app.post("/api/auth/logout", { preHandler: requireUser }, async (req, reply) => {
    await logout(ctx.db, req.sessionId!, req.user!, req.ip);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireUser }, async (req) => ({ user: req.user }));
}
