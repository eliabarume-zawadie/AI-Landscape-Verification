import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { auditEvents, humanReviews, locations } from "../../db/schema";
import { buildApp } from "../../http/app";
import { SESSION_COOKIE } from "../../http/authPlugin";
import { createUser, LoginThrottle } from "../../services/auth";
import { findConflicts } from "../../services/review";
import { createHarness, scenario, type Harness } from "../../test/harness";

let t: Harness;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const PW = "a-long-test-password";

const loc = async (externalId: string) => (await t.h.db.select().from(locations).where(eq(locations.externalId, externalId)))[0]!;
const as = (who: string) => ({ cookie: cookies[who]! });
const review = async (who: string, externalId: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/locations/${(await loc(externalId)).id}/review`, headers: as(who), payload });

beforeAll(async () => {
  t = await createHarness({
    scenarios: ["NS-DEMO-001", "NS-DEMO-002", "NS-DEMO-003", "NS-DEMO-004", "NS-DEMO-007", "NS-DEMO-009", "NS-DEMO-011"].map(scenario),
    env: { AUTOMATION_LEVEL: "3" },
  });
  app = await buildApp({ env: t.env, db: t.h.db, loginThrottle: new LoginThrottle(), ...t.runtime });
  for (const [who, role] of [["reviewer", "REVIEWER"], ["reviewer2", "REVIEWER"], ["lead", "TEAM_LEAD"]] as const) {
    await createUser(t.h.db, { email: `${who}@test.local`, displayName: who, role, password: PW }, null);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@test.local`, password: PW } });
    cookies[who] = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
  }
  await t.ingest();
  await t.worker.drain();
});
afterAll(async () => {
  await app.close();
  await t.close();
});

describe("findConflicts", () => {
  const ai = (recommendation: "RECOMMEND_APPROVE" | "RECOMMEND_REJECT" | "NEEDS_HUMAN_REVIEW", services: Record<string, [string, string]>) => ({
    runId: "r",
    recommendation,
    riskLevel: "LOW",
    services: Object.fromEntries(Object.entries(services).map(([k, [status, confidence]]) => [k, { status: status as "SUPPORTED", confidence }])),
  });
  it("needs a reason to approve when any service is not supported", () => {
    expect(findConflicts("APPROVE", ai("NEEDS_HUMAN_REVIEW", { mowing: ["INSUFFICIENT_EVIDENCE", "LOW"] }))).toHaveLength(1);
  });
  it("needs a reason to reject strong support or an approve recommendation", () => {
    expect(findConflicts("REJECT", ai("RECOMMEND_APPROVE", { mowing: ["SUPPORTED", "HIGH"] })).length).toBe(2);
  });
  it("needs no reason to agree, to escalate, or to reject unclear evidence", () => {
    expect(findConflicts("APPROVE", ai("RECOMMEND_APPROVE", { mowing: ["SUPPORTED", "HIGH"] }))).toEqual([]);
    expect(findConflicts("ESCALATE", ai("RECOMMEND_APPROVE", { mowing: ["SUPPORTED", "HIGH"] }))).toEqual([]);
    expect(findConflicts("REJECT", ai("NEEDS_HUMAN_REVIEW", { mowing: ["CONTRADICTORY", "LOW"] }))).toEqual([]);
  });
});

describe("POST /api/locations/:id/review", () => {
  it("records an agreeing approval with the AI snapshot and moves the location to APPROVED", async () => {
    const opened = await app.inject({ method: "POST", url: `/api/locations/${(await loc("NS-DEMO-002")).id}/review/open`, headers: as("reviewer") });
    const res = await review("reviewer", "NS-DEMO-002", { decision: "APPROVE", openedAt: opened.json().openedAt });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "APPROVED", isOverride: false, conflicts: [] });
    const [r] = await t.h.db.select().from(humanReviews).where(eq(humanReviews.locationId, (await loc("NS-DEMO-002")).id));
    expect(r!.aiRecommendation).toBe("RECOMMEND_APPROVE");
    expect(r!.aiSnapshot).toMatchObject({ riskLevel: "LOW", services: { mowing: { status: "SUPPORTED" } } });
    expect(r!.openedAt).not.toBeNull();
  });

  it("requires a structured reason to approve against the evidence (demo case 4)", async () => {
    const res = await review("reviewer", "NS-DEMO-004", { decision: "APPROVE" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "REASON_REQUIRED", message: expect.stringMatching(/mowing although the AI assessed it CONTRADICTORY/) });
    expect((await loc("NS-DEMO-004")).status).toBe("HUMAN_REVIEW");
  });

  it("records an override with its reason, and audits it (demo case 9)", async () => {
    const res = await review("reviewer", "NS-DEMO-009", { decision: "APPROVE", reasonCode: "AI_MISSED_EVIDENCE", reasonText: "North and south lawns are one contiguous lawn." });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "APPROVED", isOverride: true });
    const l = await loc("NS-DEMO-009");
    const ev = await t.h.db.select().from(auditEvents).where(and(eq(auditEvents.locationId, l.id), eq(auditEvents.eventType, "HUMAN_OVERRIDE")));
    expect(ev[0]!.data).toMatchObject({ reasonCode: "AI_MISSED_EVIDENCE" });
  });

  it("rejecting unclear evidence needs no reason", async () => {
    const res = await review("reviewer", "NS-DEMO-003", { decision: "REJECT" });
    expect(res.json()).toMatchObject({ status: "REJECTED", isOverride: false });
  });

  it("OTHER needs a written reason", async () => {
    const res = await review("reviewer", "NS-DEMO-004", { decision: "APPROVE", reasonCode: "OTHER" });
    expect(res.statusCode).toBe(422);
  });

  it("rejects contradictory per-service decisions", async () => {
    const res = await review("reviewer", "NS-DEMO-004", { decision: "APPROVE", serviceDecisions: { mowing: "REJECT" } });
    expect(res.statusCode).toBe(422);
  });

  it("escalated locations can only be decided by a team lead", async () => {
    expect((await review("reviewer", "NS-DEMO-004", { decision: "ESCALATE" })).json()).toMatchObject({ status: "ESCALATED" });
    expect((await review("reviewer2", "NS-DEMO-004", { decision: "REJECT" })).statusCode).toBe(403);
    expect((await review("lead", "NS-DEMO-004", { decision: "REJECT" })).json()).toMatchObject({ status: "REJECTED" });
  });

  it("a second decision on the same location is refused (no double decisions)", async () => {
    const res = await review("reviewer2", "NS-DEMO-002", { decision: "REJECT", reasonCode: "IMAGE_INSUFFICIENT" });
    expect(res.statusCode).toBe(409);
    expect((await t.h.db.select().from(humanReviews).where(eq(humanReviews.locationId, (await loc("NS-DEMO-002")).id))).length).toBe(1);
  });

  it("validates input", async () => {
    expect((await review("reviewer", "NS-DEMO-001", { decision: "MAYBE" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/locations/${(await loc("NS-DEMO-001")).id}/review`, payload: { decision: "APPROVE" } })).statusCode).toBe(401);
  });
});

describe("queue navigation and Fast Lane", () => {
  it("returns the oldest location awaiting review, optionally skipping one", async () => {
    const first = (await app.inject({ url: "/api/review/next", headers: as("reviewer") })).json().locationId;
    expect(first).toBe((await loc("NS-DEMO-001")).id);
    const second = (await app.inject({ url: `/api/review/next?after=${first}`, headers: as("reviewer") })).json().locationId;
    expect(second).not.toBe(first);
  });

  it("confirms only Fast Lane approve recommendations, one review record each", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/review/fast-lane/confirm", headers: as("reviewer"), payload: { locationIds: [(await loc("NS-DEMO-001")).id] } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe("NOT_FAST_LANE");
  });

  it("lists review history with reviewer names", async () => {
    const res = await app.inject({ url: `/api/locations/${(await loc("NS-DEMO-004")).id}/reviews`, headers: as("reviewer") });
    expect(res.json().reviews.map((r: { decision: string; reviewerName: string }) => [r.decision, r.reviewerName])).toEqual([
      ["REJECT", "lead"],
      ["ESCALATE", "reviewer"],
    ]);
  });
});

describe("Fast Lane batch confirmation (automation level 3)", () => {
  let t2: Harness;
  let app2: FastifyInstance;
  let cookie2: string;
  beforeAll(async () => {
    t2 = await createHarness({ scenarios: [scenario("NS-DEMO-002"), scenario("NS-DEMO-001")], env: { AUTOMATION_LEVEL: "3" } });
    app2 = await buildApp({ env: t2.env, db: t2.h.db, loginThrottle: new LoginThrottle(), ...t2.runtime });
    await createUser(t2.h.db, { email: "fl@test.local", displayName: "FL", role: "REVIEWER", password: PW }, null);
    const res = await app2.inject({ method: "POST", url: "/api/auth/login", payload: { email: "fl@test.local", password: PW } });
    cookie2 = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
    await t2.ingest();
    await t2.worker.drain();
  });
  afterAll(async () => {
    await app2.close();
    await t2.close();
  });

  it("records one human approval per confirmed location, flagged as batch", async () => {
    const [l] = await t2.h.db.select().from(locations).where(eq(locations.externalId, "NS-DEMO-002"));
    expect(l!.lane).toBe("FAST");
    const res = await app2.inject({ method: "POST", url: "/api/review/fast-lane/confirm", headers: { cookie: cookie2 }, payload: { locationIds: [l!.id] } });
    expect(res.json()).toEqual({ confirmed: 1 });
    const [after] = await t2.h.db.select().from(locations).where(eq(locations.id, l!.id));
    expect(after!.status).toBe("APPROVED");
    const [r] = await t2.h.db.select().from(humanReviews).where(eq(humanReviews.locationId, l!.id));
    expect(r).toMatchObject({ decision: "APPROVE", isOverride: false, aiSnapshot: expect.objectContaining({ batch: true, lane: "FAST" }) });
  });
});
