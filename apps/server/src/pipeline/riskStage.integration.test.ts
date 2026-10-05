import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { locations, riskAssessments } from "../db/schema";
import { buildApp } from "../http/app";
import { SESSION_COOKIE } from "../http/authPlugin";
import { createUser, LoginThrottle } from "../services/auth";
import { requestReprocess } from "../services/locationActions";
import { createHarness, scenario, type Harness } from "../test/harness";

const IDS = ["NS-DEMO-001", "NS-DEMO-002", "NS-DEMO-004", "NS-DEMO-006", "NS-DEMO-011"];

async function run(env: Record<string, string>) {
  const t = await createHarness({ scenarios: IDS.map(scenario), env });
  await t.ingest();
  await t.worker.drain();
  return t;
}
const loc = async (t: Harness, externalId: string) => (await t.h.db.select().from(locations).where(eq(locations.externalId, externalId)))[0]!;

describe("automation level 1 (default)", () => {
  let t: Harness;
  let app: FastifyInstance;
  let cookie: string;
  beforeAll(async () => {
    t = await run({});
    app = await buildApp({ env: t.env, db: t.h.db, loginThrottle: new LoginThrottle(), ...t.runtime });
    await createUser(t.h.db, { email: "lead@test.local", displayName: "L", role: "TEAM_LEAD", password: "a-long-test-password" }, null);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "lead@test.local", password: "a-long-test-password" } });
    cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it("records risk and recommendation per run and on the location", async () => {
    expect(await loc(t, "NS-DEMO-002")).toMatchObject({ riskLevel: "LOW", aiRecommendation: "RECOMMEND_APPROVE", lane: "HUMAN_REVIEW" });
    expect(await loc(t, "NS-DEMO-004")).toMatchObject({ riskLevel: "HIGH", aiRecommendation: "NEEDS_HUMAN_REVIEW" });
    expect(await loc(t, "NS-DEMO-011")).toMatchObject({ riskLevel: "HIGH", aiRecommendation: "NEEDS_HUMAN_REVIEW" });
    const l = await loc(t, "NS-DEMO-004");
    const [r] = await t.h.db.select().from(riskAssessments).where(eq(riskAssessments.runId, l.currentRunId!));
    expect(r!.level).toBe("HIGH");
  });

  it("never auto-decides: every location stays in human review", async () => {
    const decided = await t.h.db.select().from(locations).where(inArray(locations.status, ["APPROVED", "REJECTED"]));
    expect(decided).toEqual([]);
  });

  it("filters and sorts the queue by risk and recommendation", async () => {
    const high = (await app.inject({ url: "/api/locations?risk=HIGH", headers: { cookie } })).json();
    expect(high.items.map((i: { externalId: string }) => i.externalId).sort()).toEqual(["NS-DEMO-004", "NS-DEMO-011"]);
    const approve = (await app.inject({ url: "/api/locations?recommendation=RECOMMEND_APPROVE", headers: { cookie } })).json();
    expect(approve.items.map((i: { externalId: string }) => i.externalId)).toEqual(["NS-DEMO-002"]);
    const byRisk = (await app.inject({ url: "/api/locations?sort=risk", headers: { cookie } })).json();
    expect(byRisk.items.slice(0, 2).map((i: { riskLevel: string }) => i.riskLevel)).toEqual(["HIGH", "HIGH"]);
    const summary = (await app.inject({ url: "/api/queue/summary", headers: { cookie } })).json();
    expect(summary.awaitingReviewByRisk).toMatchObject({ HIGH: 2 });
  });

  it("evidence endpoint shows the recommendation and named factors, never the score", async () => {
    const body = (await app.inject({ url: `/api/locations/${(await loc(t, "NS-DEMO-004")).id}/evidence`, headers: { cookie } })).json();
    expect(body.recommendation).toMatchObject({ value: "NEEDS_HUMAN_REVIEW", lane: "HUMAN_REVIEW" });
    expect(body.risk.level).toBe("HIGH");
    expect(body.risk.factors[0]).toMatchObject({ factor: "CONTRADICTION", detail: expect.stringMatching(/Contradictory evidence for mowing/) });
    expect(JSON.stringify(body.risk)).not.toMatch(/internalScore|weight/);
  });

  it("clears stale risk when reprocessing, then recomputes", async () => {
    const l = await loc(t, "NS-DEMO-001");
    const u = await createUser(t.h.db, { email: "lead2@test.local", displayName: "L2", role: "TEAM_LEAD", password: "a-long-test-password" }, null);
    await requestReprocess(t.h.db, t.queue, { locationId: l.id, reason: "TECHNICAL_ERROR", userId: u.id, actor: { type: "SYSTEM" } });
    expect(await loc(t, "NS-DEMO-001")).toMatchObject({ status: "QUEUED", riskLevel: null, aiRecommendation: null });
    await t.worker.drain();
    expect((await loc(t, "NS-DEMO-001")).riskLevel).not.toBeNull();
  });
});

describe("automation level 3", () => {
  let t: Harness;
  beforeAll(async () => {
    t = await run({ AUTOMATION_LEVEL: "3" });
  });
  afterAll(async () => {
    await t.close();
  });

  it("puts only low-risk approve recommendations in the Fast Lane — still awaiting a human", async () => {
    const all = await t.h.db.select().from(locations);
    const fast = all.filter((l) => l.lane === "FAST");
    expect(fast.map((l) => l.externalId)).toEqual(["NS-DEMO-002"]);
    expect(fast[0]!.status).toBe("HUMAN_REVIEW");
  });
});

describe("automation level 3 in shadow mode", () => {
  let t: Harness;
  beforeAll(async () => {
    t = await run({ AUTOMATION_LEVEL: "3", SHADOW_MODE: "true" });
  });
  afterAll(async () => {
    await t.close();
  });

  it("never uses the Fast Lane but still records the AI recommendation", async () => {
    const all = await t.h.db.select().from(locations);
    expect(all.some((l) => l.lane === "FAST")).toBe(false);
    expect((await loc(t, "NS-DEMO-002")).aiRecommendation).toBe("RECOMMEND_APPROVE");
  });
});
