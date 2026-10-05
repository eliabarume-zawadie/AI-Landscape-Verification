import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { auditEvents, contradictions, evidence, locations, processingRuns, serviceAssessments } from "../db/schema";
import { buildApp } from "../http/app";
import { SESSION_COOKIE } from "../http/authPlugin";
import { createUser, LoginThrottle } from "../services/auth";
import { requestReprocess } from "../services/locationActions";
import { createHarness, scenario, type Harness } from "../test/harness";

let t: Harness;
let app: FastifyInstance;
let cookie: string;
let leadId: string;

const loc = async (externalId: string) => (await t.h.db.select().from(locations).where(eq(locations.externalId, externalId)))[0]!;
async function assessmentsOf(externalId: string) {
  const l = await loc(externalId);
  const rows = await t.h.db.select().from(serviceAssessments).where(eq(serviceAssessments.runId, l.currentRunId!));
  return Object.fromEntries(rows.map((r) => [r.serviceCode, r]));
}

beforeAll(async () => {
  t = await createHarness({
    scenarios: ["NS-DEMO-001", "NS-DEMO-002", "NS-DEMO-003", "NS-DEMO-004", "NS-DEMO-005", "NS-DEMO-011"].map(scenario),
  });
  app = await buildApp({ env: t.env, db: t.h.db, loginThrottle: new LoginThrottle(), ...t.runtime });
  const lead = await createUser(t.h.db, { email: "lead@test.local", displayName: "Lead", role: "TEAM_LEAD", password: "a-long-test-password" }, null);
  leadId = lead.id;
  await createUser(t.h.db, { email: "r@test.local", displayName: "R", role: "REVIEWER", password: "a-long-test-password" }, null);
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "r@test.local", password: "a-long-test-password" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
  await t.ingest();
  await t.worker.drain();
});
afterAll(async () => {
  await app.close();
  await t.close();
});

describe("evidence stage", () => {
  it("assesses every required service; the location still goes to a human", async () => {
    const a = await assessmentsOf("NS-DEMO-002");
    expect(Object.keys(a).sort()).toEqual(["edging", "mowing", "shrub_pruning", "weed_removal"]);
    // With before/after established, strong services need no extra scrutiny…
    expect(a.mowing).toMatchObject({ status: "SUPPORTED", confidenceLevel: "HIGH", humanRequired: false });
    // …the AI may recommend approval, but nothing is auto-decided: a person decides (PRD §27).
    const l = await loc("NS-DEMO-002");
    expect(l.status).toBe("HUMAN_REVIEW");
    const [run] = await t.h.db.select().from(processingRuns).where(eq(processingRuns.id, l.currentRunId!));
    expect(run!.aiRecommendation).toBe("RECOMMEND_APPROVE");
  });

  it("demo case 4: flags the uncut section as a contradiction and records the image pair", async () => {
    const l = await loc("NS-DEMO-004");
    const { mowing } = await assessmentsOf("NS-DEMO-004");
    expect(mowing).toMatchObject({ status: "CONTRADICTORY", confidenceLevel: "LOW" });
    const rows = await t.h.db.select().from(contradictions).where(eq(contradictions.runId, l.currentRunId!));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.description.includes("NS-DEMO-004-IMG005") && r.description.includes("uncut section visible"))).toBe(true);
  });

  it("demo case 3: 'weeds reduced' + equipment is insufficient, never supported", async () => {
    const { weed_removal } = await assessmentsOf("NS-DEMO-003");
    expect(weed_removal!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(weed_removal!.reasons).toContain("ONLY_CONTEXT_EVIDENCE");
  });

  it("fertilization from healthy grass is insufficient and needs a human (NS-DEMO-011)", async () => {
    const { landscape_fertilization } = await assessmentsOf("NS-DEMO-011");
    expect(landscape_fertilization).toMatchObject({ status: "INSUFFICIENT_EVIDENCE", humanRequired: true });
    expect(landscape_fertilization!.reasons).toEqual(expect.arrayContaining(["ONLY_CONTEXT_EVIDENCE", "RULE_REQUIRES_HUMAN_REVIEW"]));
  });

  it("demo case 5: unusable images never count; the requirement gap is explained", async () => {
    const a = await assessmentsOf("NS-DEMO-005");
    expect(a.trash_debris_leaves_removal!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(a.trash_debris_leaves_removal!.explanation).toMatch(/insufficient evidence/);
    // Landscape maintenance judged through the client's required components.
    expect(a.landscape_maintenance!.components).toEqual({
      mowing: expect.any(String),
      edging: expect.any(String),
      trash_debris_leaves_removal: expect.any(String),
    });
    expect(a.landscape_maintenance!.status).not.toBe("SUPPORTED");
  });

  it("records which stage inputs were evaluated", async () => {
    const [ev] = await t.h.db
      .select({ data: auditEvents.data })
      .from(auditEvents)
      .where(and(eq(auditEvents.runId, (await loc("NS-DEMO-001")).currentRunId!), eq(auditEvents.eventType, "EVIDENCE_GENERATED")));
    expect(ev!.data).toMatchObject({
      stageInputs: { beforeAfterEvaluated: true, beforeAfterEstablished: ["edging", "mowing", "shrub_pruning"], sceneCoverageEvaluated: true },
    });
  });

  it("stores supporting, contradicting and context evidence per image", async () => {
    const l = await loc("NS-DEMO-004");
    const rows = await t.h.db.select().from(evidence).where(eq(evidence.runId, l.currentRunId!));
    expect(new Set(rows.map((r) => r.role))).toEqual(new Set(["SUPPORTING", "CONTRADICTING", "CONTEXT"]));
    expect(rows.every((r) => r.imageId && r.observation)).toBe(true);
  });

  it("keeps earlier assessments when a location is reprocessed", async () => {
    const l = await loc("NS-DEMO-003");
    await requestReprocess(t.h.db, t.queue, { locationId: l.id, reason: "REVIEWER_DISPUTE", userId: leadId, actor: { type: "SYSTEM" } });
    await t.worker.drain();
    const runs = await t.h.db.select({ id: processingRuns.id }).from(processingRuns).where(eq(processingRuns.locationId, l.id));
    for (const r of runs) {
      expect((await t.h.db.select().from(serviceAssessments).where(eq(serviceAssessments.runId, r.id))).length).toBe(1);
    }
  });
});

describe("GET /api/locations/:id/evidence", () => {
  it("returns per-service assessments with bands, not raw scores", async () => {
    const l = await loc("NS-DEMO-004");
    const res = await app.inject({ url: `/api/locations/${l.id}/evidence`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.thresholdsProvisional).toBe(true);
    const mowing = body.services.find((s: { service: string }) => s.service === "mowing");
    expect(mowing).toMatchObject({ displayName: "Mowing", status: "CONTRADICTORY", confidence: "LOW", humanRequired: true });
    expect(mowing.contradictions[0]).toMatchObject({ contradictingRef: expect.stringMatching(/NS-DEMO-004-IMG/) });
    for (const item of [...mowing.supporting, ...mowing.contradicting, ...mowing.context]) {
      expect(["HIGH", "MEDIUM", "LOW"]).toContain(item.strength);
    }
    expect(JSON.stringify(body)).not.toMatch(/internalScore|0\.9/);
  });

  it("requires a session and rejects foreign run IDs", async () => {
    const l = await loc("NS-DEMO-004");
    expect((await app.inject({ url: `/api/locations/${l.id}/evidence` })).statusCode).toBe(401);
    const other = await loc("NS-DEMO-001");
    const res = await app.inject({ url: `/api/locations/${l.id}/evidence?runId=${other.currentRunId}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});
