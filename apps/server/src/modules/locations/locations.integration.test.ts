import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { locations } from "../../db/schema";
import { buildApp } from "../../http/app";
import { SESSION_COOKIE } from "../../http/authPlugin";
import { createUser, LoginThrottle } from "../../services/auth";
import { createHarness, type Harness } from "../../test/harness";

let t: Harness;
let app: FastifyInstance;
const PASSWORD = "a-long-test-password";
const cookies: Record<string, string> = {};

beforeAll(async () => {
  t = await createHarness();
  app = await buildApp({ env: t.env, db: t.h.db, loginThrottle: new LoginThrottle(), ...t.runtime });
  for (const role of ["REVIEWER", "TEAM_LEAD"] as const) {
    const email = `${role.toLowerCase()}@test.local`;
    await createUser(t.h.db, { email, displayName: role, role, password: PASSWORD }, null);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
    cookies[role] = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
  }
});
afterAll(async () => {
  await app.close();
  await t.close();
});

const as = (role: "REVIEWER" | "TEAM_LEAD") => ({ cookie: cookies[role]! });
const idOf = async (externalId: string) =>
  (await t.h.db.select({ id: locations.id }).from(locations).where(eq(locations.externalId, externalId)))[0]!.id;

describe("ingest + queue endpoints", () => {
  it("forbids reviewers from triggering ingest", async () => {
    const res = await app.inject({ method: "POST", url: "/api/admin/ingest", headers: as("REVIEWER") });
    expect(res.statusCode).toBe(403);
  });

  it("lets a team lead pull the NetSuite queue", async () => {
    const res = await app.inject({ method: "POST", url: "/api/admin/ingest", headers: as("TEAM_LEAD") });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toMatchObject({ created: 16, queued: 14, exceptions: 2 });
    await t.worker.drain();
  });

  it("summarises the queue by status and lane", async () => {
    const res = await app.inject({ url: "/api/queue/summary", headers: as("REVIEWER") });
    const body = res.json();
    expect(body.byStatus).toMatchObject({ HUMAN_REVIEW: 13, INTEGRATION_ERROR: 2, IMAGE_ERROR: 1 });
    expect(body.byLane).toMatchObject({ HUMAN_REVIEW: 13, EXCEPTION: 3 });
    expect(body.oldestUnprocessedReceivedAt).toBeNull();
  });
});

describe("GET /api/locations", () => {
  it("lists oldest first by default", async () => {
    const res = await app.inject({ url: "/api/locations?limit=3", headers: as("REVIEWER") });
    const body = res.json();
    expect(body.total).toBe(16);
    expect(body.items.map((i: { externalId: string }) => i.externalId)).toEqual(["NS-DEMO-001", "NS-DEMO-002", "NS-DEMO-003"]);
    expect(body.items[0]).toMatchObject({ client: "DEMO_CLIENT_A", imageCount: 8, services: ["edging", "mowing", "shrub_pruning"] });
  });

  it("filters by lane (Exception Lane)", async () => {
    const body = (await app.inject({ url: "/api/locations?lane=EXCEPTION", headers: as("REVIEWER") })).json();
    expect(body.items.map((i: { externalId: string }) => i.externalId).sort()).toEqual(["NS-DEMO-012", "NS-DEMO-013", "NS-DEMO-014"]);
  });

  it("filters by client, service, status, and text search", async () => {
    const byClient = (await app.inject({ url: "/api/locations?client=DEMO_CLIENT_C", headers: as("REVIEWER") })).json();
    expect(byClient.items.map((i: { externalId: string }) => i.externalId)).toEqual(["NS-DEMO-011"]);

    const byService = (await app.inject({ url: "/api/locations?service=weed_removal", headers: as("REVIEWER") })).json();
    expect(byService.items.map((i: { externalId: string }) => i.externalId).sort()).toEqual(["NS-DEMO-002", "NS-DEMO-003", "NS-DEMO-011"]);

    const byText = (await app.inject({ url: "/api/locations?q=maple", headers: as("REVIEWER") })).json();
    expect(byText.items.map((i: { externalId: string }) => i.externalId)).toEqual(["NS-DEMO-001"]);

    const byStatus = (await app.inject({ url: "/api/locations?status=IMAGE_ERROR", headers: as("REVIEWER") })).json();
    expect(byStatus.total).toBe(1);
  });

  it("finds a location by processing run ID (PRD §46)", async () => {
    const detail = (await app.inject({ url: `/api/locations/${await idOf("NS-DEMO-004")}`, headers: as("REVIEWER") })).json();
    const runId = detail.runs[0].id;
    const body = (await app.inject({ url: `/api/locations?runId=${runId}`, headers: as("REVIEWER") })).json();
    expect(body.items.map((i: { externalId: string }) => i.externalId)).toEqual(["NS-DEMO-004"]);
  });

  it("rejects invalid filters", async () => {
    expect((await app.inject({ url: "/api/locations?status=BOGUS", headers: as("REVIEWER") })).statusCode).toBe(400);
  });
});

describe("GET /api/locations/:id", () => {
  it("returns location, services, images, runs, and the audit trail", async () => {
    const res = await app.inject({ url: `/api/locations/${await idOf("NS-DEMO-001")}`, headers: as("REVIEWER") });
    const body = res.json();
    expect(body.location).toMatchObject({ externalId: "NS-DEMO-001", status: "HUMAN_REVIEW", client: "DEMO_CLIENT_A" });
    expect(body.services).toHaveLength(3);
    expect(body.images).toHaveLength(8);
    expect(body.images[0].locator).toBeUndefined(); // internal locators are not exposed
    expect(body.runs).toHaveLength(1);
    expect(body.audit.map((a: { eventType: string }) => a.eventType)).toEqual(
      expect.arrayContaining(["LOCATION_RECEIVED", "ANALYSIS_STARTED", "IMAGES_DOWNLOADED", "ANALYSIS_COMPLETED"]),
    );
  });

  it("shows open errors for exception locations", async () => {
    const body = (await app.inject({ url: `/api/locations/${await idOf("NS-DEMO-012")}`, headers: as("REVIEWER") })).json();
    expect(body.openErrors[0].message).toMatch(/No client profile/);
  });

  it("returns 404 for unknown or malformed IDs", async () => {
    expect((await app.inject({ url: "/api/locations/not-a-uuid", headers: as("REVIEWER") })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/locations/00000000-0000-4000-8000-000000000000", headers: as("REVIEWER") })).statusCode).toBe(404);
  });
});

describe("POST /api/locations/:id/reprocess", () => {
  it("is Team Lead only", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/locations/${await idOf("NS-DEMO-003")}/reprocess`,
      headers: as("REVIEWER"),
      payload: { reason: "REVIEWER_DISPUTE" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("validates the reason", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/locations/${await idOf("NS-DEMO-003")}/reprocess`,
      headers: as("TEAM_LEAD"),
      payload: { reason: "BECAUSE" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("queues a new run and exposes the job", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/locations/${await idOf("NS-DEMO-003")}/reprocess`,
      headers: as("TEAM_LEAD"),
      payload: { reason: "IMPROVED_MODEL", note: "prompt v2" },
    });
    expect(res.statusCode).toBe(202);
    const job = (await app.inject({ url: `/api/jobs/${res.json().jobId}`, headers: as("TEAM_LEAD") })).json().job;
    expect(job).toMatchObject({ type: "PROCESS_LOCATION", status: "PENDING" });

    // Second reprocess while queued is refused (not reprocessable from QUEUED).
    const again = await app.inject({
      method: "POST",
      url: `/api/locations/${await idOf("NS-DEMO-003")}/reprocess`,
      headers: as("TEAM_LEAD"),
      payload: { reason: "IMPROVED_MODEL" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "INVALID_STATE", status: "QUEUED" });

    await t.worker.drain();
    const detail = (await app.inject({ url: `/api/locations/${await idOf("NS-DEMO-003")}`, headers: as("REVIEWER") })).json();
    expect(detail.runs.map((r: { runNumber: number }) => r.runNumber)).toEqual([2, 1]);
  });
});

describe("POST /api/locations/:id/manual-review", () => {
  it("moves an exception to human review, and refuses non-exception locations", async () => {
    const ok = await app.inject({
      method: "POST",
      url: `/api/locations/${await idOf("NS-DEMO-014")}/manual-review`,
      headers: as("TEAM_LEAD"),
      payload: { note: "crew will email photos" },
    });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({
      method: "POST",
      url: `/api/locations/${await idOf("NS-DEMO-001")}/manual-review`,
      headers: as("TEAM_LEAD"),
      payload: {},
    });
    expect(bad.statusCode).toBe(409);
  });
});

describe("POST /api/jobs/location/:id", () => {
  it("refuses locations that were already queued", async () => {
    const res = await app.inject({ method: "POST", url: `/api/jobs/location/${await idOf("NS-DEMO-001")}`, headers: as("TEAM_LEAD") });
    expect(res.statusCode).toBe(409);
    expect(res.json().hint).toMatch(/reprocess/);
  });
});
