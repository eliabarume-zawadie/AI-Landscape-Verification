import { createHash, randomBytes } from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Role } from "@alvip/shared";
import { recordAudit } from "../audit/audit";
import type { Db } from "../db/client";
import { sessions, users } from "../db/schema";

const ROLE_RANK: Record<Role, number> = { REVIEWER: 1, TEAM_LEAD: 2, ADMIN: 3 };

/** Role hierarchy (PRD §52): each role has the permissions of the roles below it. */
export function hasRole(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  // @node-rs/argon2 defaults to argon2id with OWASP-recommended parameters.
  return argonHash(password);
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export async function createUser(
  db: Db,
  input: { email: string; displayName: string; role: Role; password: string },
  createdBy: AuthUser | null,
): Promise<AuthUser> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(users)
      .values({
        email: input.email.trim(),
        displayName: input.displayName.trim(),
        role: input.role,
        passwordHash,
      })
      .returning({ id: users.id, email: users.email, displayName: users.displayName, role: users.role });
    await recordAudit(tx, {
      eventType: "USER_CREATED",
      actor: createdBy ? { type: "USER", id: createdBy.id } : { type: "SYSTEM" },
      entityType: "users",
      entityId: row!.id,
      data: { email: row!.email, role: row!.role },
    });
    return row!;
  });
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// A real hash of a random value, so unknown-email logins cost the same as wrong-password ones.
const DUMMY_HASH_PROMISE = argonHash(randomBytes(16).toString("hex"));

export type LoginResult =
  | { ok: true; user: AuthUser; token: string; expiresAt: Date }
  | { ok: false; reason: "INVALID_CREDENTIALS" | "THROTTLED" };

/**
 * Simple in-process throttle: max N failures per (email, ip) per window.
 * Adequate for a single API instance; replace with a DB/edge limiter if scaled out.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60_000,
  ) {}
  private key(email: string, ip: string) {
    return `${email.toLowerCase()}|${ip}`;
  }
  isBlocked(email: string, ip: string, now = Date.now()): boolean {
    const recent = (this.failures.get(this.key(email, ip)) ?? []).filter((t) => now - t < this.windowMs);
    return recent.length >= this.maxFailures;
  }
  recordFailure(email: string, ip: string, now = Date.now()) {
    const k = this.key(email, ip);
    const recent = (this.failures.get(k) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.failures.set(k, recent);
  }
  reset(email: string, ip: string) {
    this.failures.delete(this.key(email, ip));
  }
}

export async function login(
  db: Db,
  throttle: LoginThrottle,
  input: { email: string; password: string; ip: string; userAgent?: string | undefined; ttlHours: number },
): Promise<LoginResult> {
  const email = input.email.trim();
  if (throttle.isBlocked(email, input.ip)) {
    await recordAudit(db, {
      eventType: "USER_LOGIN_FAILED",
      actor: { type: "SYSTEM" },
      data: { email, reason: "THROTTLED", ip: input.ip },
    });
    return { ok: false, reason: "THROTTLED" };
  }

  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`);

  const valid = user
    ? await argonVerify(user.passwordHash, input.password)
    : (await argonVerify(await DUMMY_HASH_PROMISE, input.password), false);

  if (!user || !valid || !user.active) {
    throttle.recordFailure(email, input.ip);
    await recordAudit(db, {
      eventType: "USER_LOGIN_FAILED",
      actor: { type: "SYSTEM" },
      entityType: user ? "users" : undefined,
      entityId: user?.id,
      data: { email, reason: user && !user.active ? "INACTIVE" : "INVALID_CREDENTIALS", ip: input.ip },
    });
    return { ok: false, reason: "INVALID_CREDENTIALS" };
  }

  throttle.reset(email, input.ip);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + input.ttlHours * 3_600_000);
  await db.transaction(async (tx) => {
    await tx.insert(sessions).values({
      tokenHash: sha256(token),
      userId: user.id,
      expiresAt,
      ip: input.ip,
      userAgent: input.userAgent ?? null,
    });
    await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    await recordAudit(tx, {
      eventType: "USER_LOGIN",
      actor: { type: "USER", id: user.id, ip: input.ip },
      entityType: "users",
      entityId: user.id,
    });
  });

  return {
    ok: true,
    token,
    expiresAt,
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
  };
}

/** Resolve a session token to an active user, or null. */
export async function authenticate(db: Db, token: string): Promise<{ user: AuthUser; sessionId: string } | null> {
  const [row] = await db
    .select({
      sessionId: sessions.id,
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, sha256(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
        eq(users.active, true),
      ),
    );
  if (!row) return null;
  const { sessionId, ...user } = row;
  return { user, sessionId };
}

export async function logout(db: Db, sessionId: string, user: AuthUser, ip?: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
    await recordAudit(tx, {
      eventType: "USER_LOGOUT",
      actor: { type: "USER", id: user.id, ip },
      entityType: "users",
      entityId: user.id,
    });
  });
}
