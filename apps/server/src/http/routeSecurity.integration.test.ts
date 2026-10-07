import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { SESSION_COOKIE } from "./authPlugin";
import { createUser, LoginThrottle } from "../services/auth";
import { createHarness, scenario, type Harness } from "../test/harness";

/**
 * Every API route, discovered from the running app: none may answer without a session, and
 * team-lead / admin routes must refuse a reviewer. A new route without an access check
 * fails here.
 */
const PUBLIC = new Set(["GET /api/health", "POST /api/auth/login"]);
/** Routes any signed-in user may call; everything else must refuse a reviewer. */
const REVIEWER_OK = new Set([
  "GET /api/auth/me",
  "POST /api/auth/logout",
  // Reference data reviewers already see on every location (service and client names).
  "GET /api/services",
  "GET /api/clients",
  "GET /api/locations",
  "GET /api/locations/:id",
  "GET /api/locations/:id/evidence",
  "GET /api/locations/:id/images",
  "GET /api/locations/:id/images/:imageId/content",
  "GET /api/locations/:id/reviews",
  "POST /api/locations/:id/review",
  "POST /api/locations/:id/review/open",
  "GET /api/locations/:id/knowledge",
  "GET /api/locations/:id/netsuite",
  "GET /api/review/next",
  "POST /api/review/fast-lane/confirm",
  "GET /api/queue/summary",
  "GET /api/knowledge",
  "GET /api/knowledge/scopes",
]);

let t: Harness;
let app: FastifyInstance;
let reviewerCookie = "";
let routes: { method: string; url: string }[] = [];
const ID = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  t = await createHarness({ scenarios: [scenario("NS-DEMO-001")] });
  const seen: { method: string; url: string }[] = [];
  app = await buildApp({ env: t.env, db: t.h.db, loginThrottle: new LoginThrottle(), ...t.runtime });
  // Fastify prints the routes as a tree; rebuild full paths from the indentation.
  const stack: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const m = line.match(/^([│ ]*)[├└]── (\S+)(?: \(([A-Z, ]+)\))?/);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    const full = (depth > 0 ? stack[depth - 1]! : "") + m[2]!;
    stack[depth] = full;
    stack.length = depth + 1;
    if (!m[3] || !full.startsWith("/api/")) continue;
    for (const method of m[3].split(", ")) if (method !== "HEAD") seen.push({ method, url: full });
  }
  routes = seen;
  await createUser(t.h.db, { email: "r@test.local", displayName: "r", role: "REVIEWER", password: "a-long-test-password" }, null);
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "r@test.local", password: "a-long-test-password" } });
  reviewerCookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
});
afterAll(async () => {
  await app.close();
  await t.close();
});

const concrete = (url: string) => url.replace(/:[A-Za-z]+/g, ID);

describe("route access", () => {
  it("discovers the API routes", () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it("every non-public API route refuses requests without a session (401)", async () => {
    const open: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.url}`;
      if (PUBLIC.has(key)) continue;
      const res = await app.inject({ method: r.method as "GET", url: concrete(r.url), payload: r.method === "GET" ? undefined : {} });
      if (res.statusCode !== 401) open.push(`${key} → ${res.statusCode}`);
    }
    expect(open).toEqual([]);
  });

  it("every team-lead and admin route refuses a reviewer (403)", async () => {
    const leaky: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.url}`;
      if (PUBLIC.has(key) || REVIEWER_OK.has(key)) continue;
      const res = await app.inject({ method: r.method as "GET", url: concrete(r.url), headers: { cookie: reviewerCookie }, payload: r.method === "GET" ? undefined : {} });
      if (res.statusCode !== 403) leaky.push(`${key} → ${res.statusCode}`);
    }
    expect(leaky).toEqual([]);
  });

  it("the reviewer allow-list only names routes that exist", () => {
    const keys = new Set(routes.map((r) => `${r.method} ${r.url}`));
    expect([...REVIEWER_OK].filter((k) => !keys.has(k))).toEqual([]);
  });
});
