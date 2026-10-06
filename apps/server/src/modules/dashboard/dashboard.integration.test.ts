import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { clients, locations } from "../../db/schema";
import { buildApp } from "../../http/app";
import { SESSION_COOKIE } from "../../http/authPlugin";
import { createUser, LoginThrottle } from "../../services/auth";
import { buildDashboard, localToday } from "../../services/dashboard";
import { createHarness, scenario, type Harness } from "../../test/harness";

let t: Harness;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const PW = "a-long-test-password";
const as = (who: string) => ({ cookie: cookies[who]! });
const loc = async (externalId: string) => (await t.h.db.select().from(locations).where(eq(locations.externalId, externalId)))[0]!;
const review = async (externalId: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/locations/${(await loc(externalId)).id}/review`, headers: as("reviewer"), payload });
const today = () => localToday("UTC");

beforeAll(async () => {
  t = await createHarness({
    scenarios: ["NS-DEMO-001", "NS-DEMO-002", "NS-DEMO-003", "NS-DEMO-004", "NS-DEMO-008", "NS-DEMO-009"].map(scenario),
    env: { METRICS_TIMEZONE: "UTC", METRICS_BASELINE_REVIEW_SECONDS: "240" },
  });
  app = await buildApp({ env: t.env, db: t.h.db, loginThrottle: new LoginThrottle(), ...t.runtime });
  for (const [who, role] of [["reviewer", "REVIEWER"], ["lead", "TEAM_LEAD"]] as const) {
    await createUser(t.h.db, { email: `${who}@test.local`, displayName: who, role, password: PW }, null);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@test.local`, password: PW } });
    cookies[who] = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
  }
  await t.ingest();
  await t.worker.drain();
  for (const id of ["NS-DEMO-002", "NS-DEMO-003"]) {
    await app.inject({ method: "POST", url: `/api/locations/${(await loc(id)).id}/review/open`, headers: as("reviewer") });
  }
  await review("NS-DEMO-002", { decision: "APPROVE", openedAt: new Date(Date.now() - 30_000).toISOString() });
  await review("NS-DEMO-003", { decision: "REJECT", openedAt: new Date(Date.now() - 90_000).toISOString() });
  await review("NS-DEMO-009", { decision: "APPROVE", reasonCode: "AI_MISSED_EVIDENCE" });
  await review("NS-DEMO-004", { decision: "ESCALATE" });
  await t.worker.drain(); // sends decisions to (mock) NetSuite
});
afterAll(async () => {
  await app.close();
  await t.close();
});

describe("GET /api/dashboard", () => {
  it("is for team leads", async () => {
    expect((await app.inject({ url: "/api/dashboard", headers: as("reviewer") })).statusCode).toBe(403);
  });

  it("reports today's queue, timing, AI, efficiency, cost and NetSuite figures", async () => {
    const res = await app.inject({ url: "/api/dashboard", headers: as("lead") });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.period).toMatchObject({ from: today(), to: today(), timezone: "UTC", isToday: true });
    expect(d.queue).toMatchObject({ received: 6, decided: 3, escalated: 1, completed: 3, awaitingReview: 2, waitingForNetSuite: 0 });
    expect(d.queue.aiProcessed).toBe(5); // demo 8: AI provider down → no successful run
    expect(d.queue.problems).toBe(1);
    expect(d.queue.remaining).toBe(3); // 001 + escalated 004 awaiting review, 008 AI problem
    expect(d.queue.clearance).toMatchObject({ numerator: 3, denominator: 6, value: 0.5 });
    expect(d.timing.reviewsTimed).toBe(2);
    expect(d.timing.reviewSecondsMedian).toBeGreaterThanOrEqual(60);
    expect(d.timing.processingSecondsPerLocation).toBeGreaterThan(0);
    // 3 decisions < 30: rates are suppressed, never shown as percentages.
    expect(d.minSample).toBe(30);
    expect(d.ai.override).toMatchObject({ value: null, suppressed: true, numerator: 1, denominator: 3 });
    expect(d.ai.falseApproval).toMatchObject({ measured: false });
    expect(d.ai.imagesAnalyzed.denominator).toBeGreaterThan(30);
    expect(d.ai.imagesAnalyzed.value).toBeGreaterThan(0.5);
    expect(d.efficiency).toMatchObject({ baselineReviewSeconds: 240 });
    expect(d.efficiency.timeSavedSecondsPerLocation).toBeGreaterThan(0);
    expect(d.cost.runs).toBeGreaterThanOrEqual(5);
    expect(typeof d.cost.totalUsd).toBe("number");
    expect(d.netsuite).toMatchObject({ sent: 4, stopped: 0 }); // 3 results + 1 note (demo 9 had a reason)
    expect(d.netsuite.meanLatencyMs).not.toBeNull();
    expect(d.reviewers).toEqual([expect.objectContaining({ name: "reviewer", decisions: 3, escalations: 1 })]);
    const texts = d.diagnosis.map((x: { text: string }) => x.text);
    expect(texts[0]).toBe("The AI provider is failing: 1 location stopped with an AI problem. A team lead can send it to manual review.");
    expect(texts).toContainEqual(expect.stringMatching(/^2 locations waiting for a reviewer; the oldest has waited \d+ (min|h)\.$/));
  });

  it("filters by client and service", async () => {
    const [b] = await t.h.db.select().from(clients).where(eq(clients.code, "DEMO_CLIENT_B"));
    const none = (await app.inject({ url: `/api/dashboard?client=${b!.id}`, headers: as("lead") })).json();
    expect(none.queue).toMatchObject({ received: 0, decided: 0 });
    const weeds = (await app.inject({ url: "/api/dashboard?service=weed_removal", headers: as("lead") })).json();
    expect(weeds.queue.received).toBeLessThan(6);
    expect(weeds.queue.received).toBeGreaterThan(0);
  });

  it("validates the date range", async () => {
    expect((await app.inject({ url: "/api/dashboard?from=2026-10-05&to=2026-10-01", headers: as("lead") })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/dashboard?from=2024-01-01&to=2026-10-01", headers: as("lead") })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/dashboard?from=yesterday", headers: as("lead") })).statusCode).toBe(400);
    const past = (await app.inject({ url: "/api/dashboard?from=2020-01-01&to=2020-01-31", headers: as("lead") })).json();
    expect(past.queue).toMatchObject({ received: 0, decided: 0 });
    expect(past.period.isToday).toBe(false);
  });

  it("shows rates once there is enough data (minimum sample is configurable)", async () => {
    const d = await buildDashboard(t.h.db, { from: today(), to: today() }, { timezone: "UTC", minSample: 1, baselineReviewSeconds: null });
    expect(d.ai.override).toMatchObject({ value: 1 / 3, suppressed: false });
    expect(d.efficiency.timeSavedSecondsPerLocation).toBeNull(); // baseline not configured → not guessed
  });
});
