import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Role } from "@alvip/shared";
import { authenticate, hasRole, type AuthUser } from "../services/auth";
import type { AppContext } from "./context";

export const SESSION_COOKIE = "alvip_session";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
    sessionId: string | null;
  }
}

/** Resolves the session cookie on every request. Route guards decide what is required. */
export async function registerAuth(app: FastifyInstance, ctx: AppContext) {
  app.decorateRequest("user", null);
  app.decorateRequest("sessionId", null);

  app.addHook("onRequest", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = await authenticate(ctx.db, token);
    if (session) {
      req.user = session.user;
      req.sessionId = session.sessionId;
    }
  });
}

/** Guard: authenticated user with at least `role` (PRD §52 hierarchy). */
export function requireRole(role: Role): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: "UNAUTHENTICATED" });
    if (!hasRole(req.user.role, role)) return reply.code(403).send({ error: "FORBIDDEN" });
  };
}

export const requireUser = requireRole("REVIEWER");
