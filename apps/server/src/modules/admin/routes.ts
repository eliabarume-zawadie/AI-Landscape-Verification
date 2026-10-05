import type { FastifyInstance } from "fastify";
import { asc } from "drizzle-orm";
import { z } from "zod";
import { ROLES } from "@alvip/shared";
import { users } from "../../db/schema";
import { requireRole } from "../../http/authPlugin";
import type { AppContext } from "../../http/context";
import { createUser, MIN_PASSWORD_LENGTH } from "../../services/auth";

const createUserBody = z.object({
  email: z.string().email().max(320),
  displayName: z.string().min(1).max(200),
  role: z.enum(ROLES),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
});

export async function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/admin/users", { preHandler: requireRole("ADMIN") }, async () => {
    const rows = await ctx.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        active: users.active,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .orderBy(asc(users.email));
    return { users: rows };
  });

  app.post("/api/admin/users", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    const parsed = createUserBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REQUEST", issues: parsed.error.issues });
    }
    try {
      const user = await createUser(ctx.db, parsed.data, req.user!);
      return reply.code(201).send({ user });
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send({ error: "EMAIL_EXISTS" });
      throw err;
    }
  });
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}
