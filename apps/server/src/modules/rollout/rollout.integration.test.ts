import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { clients, locations, processingRuns, qcSamples } from "../../db/schema";
import { buildApp } from "../../http/app";
import { SESSION_COOKIE } from "../../http/authPlugin";
import { createUser, LoginThrottle } from "../../services/auth";
import { applyEnv, fastLaneAllowed, RolloutError, setRollout, type EffectiveRollout } from "../../services/rollout";
import { createHarness, scenario, type Harness } from "../../test/harness";

let t: Harness;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const users: Record<string, string> = {};
const PW = "a-long-test-password";
const as = (who: string) => ({ cookie: cookies[who]! });
const loc = async (externalId: string) => (await t.h.db.select().from(locations).where(eq(locations.externalId, externalId)))[0]!;
const post = (who: string, url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: as(who), payload });
const clientA = async () => (await t.h.db.select().from(clients).where(eq(clients.code, "DEMO_CLIENT_A")))[0]!.id;
const latestRun = async (externalId: string) => (await t.h.db.select().from(processingRuns).where(eq(processingRuns.locationId, (await loc(externalId)).id)).orderBy(desc(processingRuns.runNumber)))[0]!;
const dbError = (p: Promise<unknown>) => p.then(
  () => "no error",
  (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
);

beforeAll(async () => {
  t = await createHarness({
    scenarios: ["NS-DEMO-001", "NS-DEMO-002", "NS-DEMO-003", "NS-DEMO-004", "NS-DEMO-007"].map(scenario),
    env: { AUTOMATION_LEVEL: "3", QC_SAMPLE_RATE_FAST_LANE: "1", QC_SAMPLE_RATE_APPROVALS: "1" },
  });
  app = await buildApp({ env: t.env, db: t.h.db, loginThrottle: new LoginThrottle(), ...t.runtime });
  for (const [who, role] of [["reviewer", "REVIEWER"], ["lead", "TEAM_LEAD"], ["admin", "ADMIN"]] as const) {
    users[who] = (await createUser(t.h.db, { email: `${who}@test.local`, displayName: who, role, password: PW }, null)).id;
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

describe("rollout rules", () => {
  const env = (level: number, shadow = false) => ({ AUTOMATION_LEVEL: level as 0 | 1 | 2 | 3, SHADOW_MODE: shadow });
  it("the server settings are the ceiling, and SHADOW_MODE is a global switch", () => {
    expect(applyEnv("FAST_TRACK", env(3))).toBe("FAST_TRACK");
    expect(applyEnv("FAST_TRACK", env(2))).toBe("ASSIST");
    expect(applyEnv("ASSIST", env(0))).toBe("MANUAL");
    expect(applyEnv("FAST_TRACK", env(3, true))).toBe("SHADOW");
    expect(applyEnv("MANUAL", env(3, true))).toBe("MANUAL");
  });
  it("the Fast Lane needs fast track for every required service", () => {
    const r = { mode: "FAST_TRACK", fastTrackServices: ["mowing", "edging"] } as EffectiveRollout;
    expect(fastLaneAllowed(r, ["mowing"])).toBe(true);
    expect(fastLaneAllowed(r, ["mowing", "shrub_pruning"])).toBe(false);
    expect(fastLaneAllowed({ ...r, mode: "ASSIST" }, ["mowing"])).toBe(false);
    expect(fastLaneAllowed({ ...r, fastTrackServices: ["*"] }, ["anything"])).toBe(true);
  });
});

describe("controlled rollout (PRD §71, §90)", () => {
  it("without settings, the environment applies (here: fast track for all services)", async () => {
    const r = (await app.inject({ url: "/api/rollout", headers: as("lead") })).json();
    expect(r).toMatchObject({ ceiling: "FAST_TRACK", default: { source: "ENVIRONMENT", mode: "FAST_TRACK" } });
    expect((await loc("NS-DEMO-002")).lane).toBe("FAST");
  });

  it("only admins change it, with a reason; fast track needs evidence or an explicit acknowledgement", async () => {
    const id = await clientA();
    expect((await post("lead", "/api/rollout", { clientId: id, mode: "ASSIST", reason: "x" })).statusCode).toBe(403);
    expect((await post("admin", "/api/rollout", { clientId: id, mode: "ASSIST", reason: " " })).statusCode).toBe(400);
    const noAck = await post("admin", "/api/rollout", { clientId: id, mode: "FAST_TRACK", fastTrackServices: ["mowing"], reason: "Pilot" });
    expect(noAck.statusCode).toBe(428);
    expect(noAck.json().error).toBe("VALIDATION_REQUIRED");
    expect((await post("admin", "/api/rollout", { clientId: id, mode: "FAST_TRACK", fastTrackServices: [], reason: "Pilot", acknowledgeNoValidation: true })).statusCode).toBe(422);
  });

  it("narrowing fast track moves waiting Fast Lane locations back to normal review at once (rollback)", async () => {
    const res = await post("admin", "/api/rollout", {
      clientId: await clientA(),
      mode: "FAST_TRACK",
      fastTrackServices: ["mowing"],
      reason: "Ops director approved a mowing-only pilot (email 2026-10-06)",
      acknowledgeNoValidation: true,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ effective: { mode: "FAST_TRACK", fastTrackServices: ["mowing"], validated: false } });
    expect(res.json().movedOutOfFastLane).toBeGreaterThanOrEqual(1);
    expect((await loc("NS-DEMO-002")).lane).toBe("HUMAN_REVIEW"); // needs edging, weed removal, shrub pruning too
    const hist = (await app.inject({ url: `/api/rollout/history?client=${await clientA()}`, headers: as("lead") })).json().history;
    expect(hist[0]).toMatchObject({ mode: "FAST_TRACK", validated: false, setByName: "admin" });
    expect(await dbError(t.h.db.execute(sql`update rollout_settings set mode = 'ASSIST'`))).toMatch(/append-only/);
  });

  it("the server setting stays the ceiling", async () => {
    await expect(
      setRollout(t.h.db, { ...t.env, AUTOMATION_LEVEL: 2 }, { type: "USER", id: users.admin! }, { clientId: null, mode: "FAST_TRACK", fastTrackServices: ["mowing"], reason: "x", acknowledgeNoValidation: true }),
    ).rejects.toMatchObject({ code: "ABOVE_CEILING" } satisfies Partial<RolloutError>);
  });

  it("SHADOW for one client: its next runs hide the AI from reviewers", async () => {
    expect((await post("admin", "/api/rollout", { clientId: await clientA(), mode: "SHADOW", reason: "Start the shadow trial" })).statusCode).toBe(201);
    const id = (await loc("NS-DEMO-004")).id;
    expect((await post("lead", `/api/locations/${id}/reprocess`, { reason: "CONFIG_CHANGE" })).statusCode).toBe(202);
    await t.worker.drain();
    expect(await latestRun("NS-DEMO-004")).toMatchObject({ shadowMode: true, automationLevel: 1, status: "SUCCEEDED" });
    expect((await app.inject({ url: `/api/locations/${id}/evidence`, headers: as("reviewer") })).json().aiHidden).toBe(true);
  });

  it("MANUAL for one client: no AI analysis at all; a person verifies the photos", async () => {
    expect((await post("admin", "/api/rollout", { clientId: await clientA(), mode: "MANUAL", reason: "Rollback: AI provider contract paused" })).statusCode).toBe(201);
    const id = (await loc("NS-DEMO-003")).id;
    t.vision.calls.length = 0;
    expect((await post("lead", `/api/locations/${id}/reprocess`, { reason: "CONFIG_CHANGE" })).statusCode).toBe(202);
    await t.worker.drain();
    expect(await latestRun("NS-DEMO-003")).toMatchObject({ automationLevel: 0, shadowMode: false });
    expect(t.vision.calls).toHaveLength(0);
    expect(await loc("NS-DEMO-003")).toMatchObject({ status: "HUMAN_REVIEW", aiRecommendation: null }); // no AI result at all
    expect((await post("admin", "/api/rollout", { clientId: await clientA(), mode: "ASSIST", reason: "Back to assist" })).statusCode).toBe(201);
  });
});

describe("quality-control sampling", () => {
  it("samples approvals for a second check and never lets reviewers check their own decision", async () => {
    // Fast Lane location from the environment default (client A's own setting no longer applies to it: decide it now).
    const r = await post("reviewer", `/api/locations/${(await loc("NS-DEMO-001")).id}/review`, { decision: "APPROVE", reasonCode: "OTHER", reasonText: "Checked on site." });
    expect(r.statusCode).toBe(201);
    expect(r.json().qcSampled).toBe(true);
    expect((await post("reviewer", `/api/locations/${(await loc("NS-DEMO-002")).id}/review`, { decision: "REJECT", reasonCode: "IMAGE_INSUFFICIENT" })).json().qcSampled).toBe(false); // rejections aren't sampled
    const [sample] = await t.h.db.select().from(qcSamples);
    expect(sample).toMatchObject({ reason: "RANDOM", status: "PENDING" });

    expect((await post("reviewer", `/api/qc/${sample!.id}`, { verdict: "CONFIRMED" })).statusCode).toBe(403); // role
    expect((await post("lead", `/api/qc/${sample!.id}`, { verdict: "DISAGREE" })).statusCode).toBe(422); // needs the correct decision + why
    expect((await post("lead", `/api/qc/${sample!.id}`, { verdict: "DISAGREE", correctDecision: "REJECT", note: "Back strip uncut in IMG005." })).statusCode).toBe(200);
    expect((await post("lead", `/api/qc/${sample!.id}`, { verdict: "CONFIRMED" })).statusCode).toBe(409);
    expect(await dbError(t.h.db.execute(sql`update qc_samples set verdict = 'CONFIRMED'`))).toMatch(/completed once/);

    const q = (await app.inject({ url: "/api/qc", headers: as("lead") })).json();
    expect(q.samples[0]).toMatchObject({ externalId: "NS-DEMO-001", verdict: "DISAGREE", correctDecision: "REJECT", checkedByName: "lead", reviewerName: "reviewer" });
    expect(q.stats.overall).toMatchObject({ checked: 1, disagree: 1, rate: 1, smallSample: true });
  });

  it("the person who decided can't do the QC check", async () => {
    // The lead decides; the lead's own approval gets sampled; only someone else may check it.
    const res = await post("lead", `/api/locations/${(await loc("NS-DEMO-007")).id}/review`, { decision: "APPROVE" });
    expect(res.json().qcSampled).toBe(true);
    const [s] = await t.h.db.select().from(qcSamples).where(eq(qcSamples.status, "PENDING"));
    expect((await post("lead", `/api/qc/${s!.id}`, { verdict: "CONFIRMED" })).statusCode).toBe(403);
    expect((await post("admin", `/api/qc/${s!.id}`, { verdict: "CONFIRMED" })).statusCode).toBe(200);
  });
});
