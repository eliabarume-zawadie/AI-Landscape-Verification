import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import { auditEvents } from "../db/schema";
import { createUser, LoginThrottle } from "../services/auth";
import { createTestDb, testEnv } from "../test/helpers";
import { createRuntime } from "../runtime";
import { buildApp } from "./app";
import { SESSION_COOKIE } from "./authPlugin";

let h: DbHandle;
let app: FastifyInstance;
const PASSWORD = "a-long-test-password";

beforeAll(async () => {
  h = await createTestDb();
  const env = testEnv();
  app = await buildApp({ env, db: h.db, loginThrottle: new LoginThrottle(3, 60_000), ...createRuntime(env, h.db) });
  for (const [email, role] of [
    ["admin@test.local", "ADMIN"],
    ["lead@test.local", "TEAM_LEAD"],
    ["reviewer@test.local", "REVIEWER"],
    ["locked@test.local", "REVIEWER"],
  ] as const) {
    await createUser(h.db, { email, displayName: email, role, password: PASSWORD }, null);
  }
});
afterAll(async () => {
  await app.close();
  await h.close();
});

async function loginAs(email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  expect(c).toBeDefined();
  return c!.value;
}

const withSession = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });

describe("health", () => {
  it("is public and reports ok", async () => {
    const res = await app.inject({ url: "/api/health" });
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("authentication", () => {
  it("sets an httpOnly, SameSite=Strict session cookie and audits the login", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "Reviewer@Test.Local", password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((x) => x.name === SESSION_COOKIE)!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe("Strict");
    expect(res.json().user.role).toBe("REVIEWER");
    expect(res.json().user.passwordHash).toBeUndefined();

    const [last] = await h.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "USER_LOGIN"))
      .orderBy(desc(auditEvents.id))
      .limit(1);
    expect(last).toBeDefined();
  });

  it("rejects wrong passwords and unknown users identically", async () => {
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "lead@test.local", password: "nope-nope-nope" },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "ghost@test.local", password: "nope-nope-nope" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("throttles repeated failures, even if the next attempt is correct", async () => {
    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "locked@test.local", password: "wrong-password-x" },
      });
    for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(429);
    const correct = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "locked@test.local", password: PASSWORD },
    });
    expect(correct.statusCode).toBe(429);
  });

  it("requires a session for protected routes", async () => {
    expect((await app.inject({ url: "/api/auth/me" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/auth/me", headers: withSession("forged") })).statusCode).toBe(401);
  });

  it("revokes the session on logout", async () => {
    const token = await loginAs("lead@test.local");
    expect((await app.inject({ url: "/api/auth/me", headers: withSession(token) })).statusCode).toBe(200);
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: withSession(token) });
    expect(out.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/auth/me", headers: withSession(token) })).statusCode).toBe(401);
  });
});

describe("authorization (PRD §52)", () => {
  it("lets reviewers read services but not thresholds or admin endpoints", async () => {
    const token = await loginAs("reviewer@test.local");
    expect((await app.inject({ url: "/api/services", headers: withSession(token) })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/config/thresholds", headers: withSession(token) })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/admin/users", headers: withSession(token) })).statusCode).toBe(403);
  });

  it("hides full client rules from reviewers but shows them to team leads", async () => {
    const reviewer = await loginAs("reviewer@test.local");
    const lead = await loginAs("lead@test.local");
    const r = (await app.inject({ url: "/api/clients", headers: withSession(reviewer) })).json();
    const l = (await app.inject({ url: "/api/clients", headers: withSession(lead) })).json();
    expect(r.clients[0].profile).toBeUndefined();
    expect(l.clients[0].profile).toBeDefined();
  });

  it("lets team leads read thresholds (flagged provisional) but not manage users", async () => {
    const token = await loginAs("lead@test.local");
    const res = await app.inject({ url: "/api/config/thresholds", headers: withSession(token) });
    expect(res.json().thresholds.provisional).toBe(true);
    expect((await app.inject({ url: "/api/admin/users", headers: withSession(token) })).statusCode).toBe(403);
  });

  it("lets admins create users, rejecting weak passwords and duplicates", async () => {
    const token = await loginAs("admin@test.local");
    const create = (password: string, email = "new@test.local") =>
      app.inject({
        method: "POST",
        url: "/api/admin/users",
        headers: withSession(token),
        payload: { email, displayName: "New", role: "REVIEWER", password },
      });
    expect((await create("short")).statusCode).toBe(400);
    expect((await create("a-sufficiently-long-pw")).statusCode).toBe(201);
    expect((await create("a-sufficiently-long-pw", "NEW@test.local")).statusCode).toBe(409);
  });
});

describe("security headers", () => {
  it("sets baseline headers", async () => {
    const res = await app.inject({ url: "/api/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
