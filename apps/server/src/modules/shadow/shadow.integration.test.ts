import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { feedback, humanReviews, locations, processingRuns } from "../../db/schema";
import { buildApp } from "../../http/app";
import { SESSION_COOKIE } from "../../http/authPlugin";
import { createUser, LoginThrottle } from "../../services/auth";
import { aiHiddenFor } from "../../services/shadow";
import { createHarness, scenario, type Harness } from "../../test/harness";

let t: Harness;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const PW = "a-long-test-password";
const as = (who: string) => ({ cookie: cookies[who]! });
const loc = async (externalId: string) => (await t.h.db.select().from(locations).where(eq(locations.externalId, externalId)))[0]!;
const get = async (who: string, url: string) => (await app.inject({ url, headers: as(who) })).json();
const review = async (who: string, externalId: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/locations/${(await loc(externalId)).id}/review`, headers: as(who), payload });

beforeAll(async () => {
  t = await createHarness({
    scenarios: ["NS-DEMO-001", "NS-DEMO-002", "NS-DEMO-004"].map(scenario),
    env: { SHADOW_MODE: "true", AUTOMATION_LEVEL: "3", METRICS_TIMEZONE: "UTC" },
  });
  app = await buildApp({ env: t.env, db: t.h.db, loginThrottle: new LoginThrottle(), ...t.runtime });
  for (const [who, role] of [["reviewer", "REVIEWER"], ["lead", "TEAM_LEAD"]] as const) {
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

describe("aiHiddenFor", () => {
  it("hides shadow AI from reviewers always, from leads until decided, and never outside shadow mode", () => {
    expect(aiHiddenFor("REVIEWER", true, "COMPLETED")).toBe(true);
    expect(aiHiddenFor("TEAM_LEAD", true, "HUMAN_REVIEW")).toBe(true);
    expect(aiHiddenFor("TEAM_LEAD", true, "APPROVED")).toBe(false);
    expect(aiHiddenFor("REVIEWER", false, "HUMAN_REVIEW")).toBe(false);
  });
});

describe("shadow mode (PRD §89)", () => {
  it("the AI still analyses every location, recorded as a shadow run, and nothing is fast-tracked", async () => {
    const runs = await t.h.db.select().from(processingRuns);
    expect(runs.length).toBe(3);
    expect(runs.every((r) => r.shadowMode && r.status === "SUCCEEDED")).toBe(true);
    const l = await loc("NS-DEMO-002");
    expect(l.aiRecommendation).toBe("RECOMMEND_APPROVE"); // recorded…
    expect(l.lane).toBe("HUMAN_REVIEW"); // …but no Fast Lane
  });

  it("people deciding see no AI output in any endpoint", async () => {
    for (const who of ["reviewer", "lead"]) {
      const list = await get(who, "/api/locations?limit=50");
      expect(list.items.every((i: { riskLevel: unknown; aiRecommendation: unknown }) => i.riskLevel === null && i.aiRecommendation === null)).toBe(true);
      // Filtering or sorting by AI fields must not reveal them either.
      expect((await get(who, "/api/locations?risk=HIGH")).items).toHaveLength(0);
      expect((await get(who, "/api/locations?recommendation=RECOMMEND_APPROVE")).items).toHaveLength(0);
    }
    const id = (await loc("NS-DEMO-004")).id;
    const ev = await get("reviewer", `/api/locations/${id}/evidence`);
    expect(ev).toMatchObject({ aiHidden: true, recommendation: null, risk: null, services: [], requiredServices: [{ service: "mowing" }] });
    const imgs = await get("reviewer", `/api/locations/${id}/images?order=evidence`);
    expect(imgs.items.every((i: { inBundle: boolean; analysis: { evidenceRank: unknown; usable: unknown } }) => !i.inBundle && i.analysis.evidenceRank === null && i.analysis.usable !== null)).toBe(true);
    const detail = await get("reviewer", `/api/locations/${id}`);
    expect(detail).toMatchObject({ shadow: true, aiHidden: true, location: { aiRecommendation: null, riskLevel: null } });
    const risk = detail.audit.find((a: { eventType: string }) => a.eventType === "RISK_CALCULATED");
    expect(risk.data).toEqual({});
    const summary = await get("reviewer", "/api/queue/summary");
    expect(Object.keys(summary.awaitingReviewByRisk)).toEqual(["NONE"]);
  });

  it("decisions need no reason against an AI the person could not see; the AI view is still recorded", async () => {
    // The AI found mowing CONTRADICTORY here; approving needs no reason in shadow mode.
    const res = await review("reviewer", "NS-DEMO-004", { decision: "APPROVE" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ isOverride: false, conflicts: [], feedbackRows: 0 });
    const [r] = await t.h.db.select().from(humanReviews).where(eq(humanReviews.locationId, (await loc("NS-DEMO-004")).id));
    expect(r).toMatchObject({ shadowMode: true, isOverride: false, aiRecommendation: "NEEDS_HUMAN_REVIEW" });
    expect((r!.aiSnapshot as { shadowDisagreements: string[] }).shadowDisagreements[0]).toMatch(/mowing although the AI assessed it CONTRADICTORY/);
    expect(await t.h.db.select().from(feedback)).toHaveLength(0);
    // The AI would have approved 002; the reviewer rejects it.
    expect((await review("reviewer", "NS-DEMO-002", { decision: "REJECT" })).statusCode).toBe(201);
    expect((await review("reviewer", "NS-DEMO-001", { decision: "APPROVE" })).statusCode).toBe(201);
  });

  it("after the decision, team leads can compare with the AI; reviewers still can't", async () => {
    const id = (await loc("NS-DEMO-004")).id;
    expect((await get("lead", `/api/locations/${id}/evidence`)).services[0]).toMatchObject({ service: "mowing", status: "CONTRADICTORY" });
    expect((await get("reviewer", `/api/locations/${id}/evidence`)).aiHidden).toBe(true);
  });

  it("the shadow results record AI vs human, agreement, disagreement and timing", async () => {
    expect((await app.inject({ url: "/api/shadow", headers: as("reviewer") })).statusCode).toBe(403);
    const r = await get("lead", "/api/shadow");
    expect(r).toMatchObject({ enabled: true, summary: { decisions: 3 } });
    const byId = Object.fromEntries(r.items.map((i: { externalId: string }) => [i.externalId, i]));
    expect(byId["NS-DEMO-002"]).toMatchObject({ aiRecommendation: "RECOMMEND_APPROVE", decision: "REJECT", agreement: "DISAGREE", aiApproveHumanReject: true });
    expect(byId["NS-DEMO-004"]).toMatchObject({ agreement: "AI_DEFERRED", aiApproveHumanReject: false });
    expect(byId["NS-DEMO-004"].aiServices.mowing.status).toBe("CONTRADICTORY");
    expect(byId["NS-DEMO-002"].aiSeconds).toBeGreaterThan(0);
    expect(r.summary.aiApproveHumanReject).toMatchObject({ numerator: 1, denominator: 1, suppressed: true, ci95: expect.any(Object) });
    expect(r.summary.byService.mowing).toMatchObject({ denominator: expect.any(Number) });
  });
});
