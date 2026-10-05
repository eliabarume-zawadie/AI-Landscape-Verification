import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { auditEvents, imageAnalysis, imagePairs, images, locations, serviceAssessments } from "../db/schema";
import { buildApp } from "../http/app";
import { SESSION_COOKIE } from "../http/authPlugin";
import type { MockScenario } from "../integrations/netsuite/mock/scenarios";
import { createUser, LoginThrottle } from "../services/auth";
import { requestReprocess } from "../services/locationActions";
import { createHarness, scenario, type Harness } from "../test/harness";

let t: Harness;
let app: FastifyInstance;
let cookie: string;
let leadId: string;

const loc = async (externalId: string) => (await t.h.db.select().from(locations).where(eq(locations.externalId, externalId)))[0]!;
const assessment = async (externalId: string, service: string) =>
  (await t.h.db.select().from(serviceAssessments).where(and(eq(serviceAssessments.runId, (await loc(externalId)).currentRunId!), eq(serviceAssessments.serviceCode, service))))[0]!;
const pairsOf = async (externalId: string) =>
  t.h.db.select().from(imagePairs).where(eq(imagePairs.runId, (await loc(externalId)).currentRunId!));
const summaryOf = async (externalId: string) =>
  (
    await t.h.db
      .select({ data: auditEvents.data })
      .from(auditEvents)
      .where(and(eq(auditEvents.runId, (await loc(externalId)).currentRunId!), eq(auditEvents.eventType, "BEFORE_AFTER_COMPLETED")))
  )[0]!.data as Record<string, unknown>;

/** Same photos as demo case 1, but no before/after words in filenames and no timestamps. */
const unlabelled: MockScenario = {
  ...scenario("NS-DEMO-001"),
  externalId: "NS-T-UNLABELLED",
  images: scenario("NS-DEMO-001").images.map((i, n) => ({ ...i, ref: `U${n + 1}`, filename: `IMG_${1000 + n}.jpg`, capturedAt: undefined })),
};

beforeAll(async () => {
  t = await createHarness({
    scenarios: [...["NS-DEMO-001", "NS-DEMO-004", "NS-DEMO-009", "NS-DEMO-010", "NS-DEMO-011"].map(scenario), unlabelled],
  });
  app = await buildApp({ env: t.env, db: t.h.db, loginThrottle: new LoginThrottle(), ...t.runtime });
  leadId = (await createUser(t.h.db, { email: "lead@test.local", displayName: "L", role: "TEAM_LEAD", password: "a-long-test-password" }, null)).id;
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "lead@test.local", password: "a-long-test-password" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
  await t.ingest();
  await t.worker.drain();
});
afterAll(async () => {
  await app.close();
  await t.close();
});

describe("before/after stage", () => {
  it("labels photos from metadata (filename + time agree → STRONG)", async () => {
    const rows = await t.h.db
      .select({ ref: images.externalRef, stage: imageAnalysis.stage, certainty: imageAnalysis.stageCertainty })
      .from(imageAnalysis)
      .innerJoin(images, eq(images.id, imageAnalysis.imageId))
      .where(eq(imageAnalysis.runId, (await loc("NS-DEMO-001")).currentRunId!))
      .orderBy(asc(images.ordinal));
    expect(rows.slice(0, 2)).toEqual([
      { ref: "NS-DEMO-001-IMG001", stage: "BEFORE", certainty: "STRONG" },
      { ref: "NS-DEMO-001-IMG002", stage: "AFTER", certainty: "STRONG" },
    ]);
  });

  it("demo case 1: confirms same-area pairs and supports the services", async () => {
    const pairs = await pairsOf("NS-DEMO-001");
    expect(pairs.filter((p) => p.status === "CONFIRMED")).toHaveLength(3);
    expect(await assessment("NS-DEMO-001", "mowing")).toMatchObject({ status: "SUPPORTED", confidenceLevel: "HIGH" });
    expect(await summaryOf("NS-DEMO-001")).toMatchObject({ established: ["edging", "mowing", "shrub_pruning"], distinctAreas: 1 });
  });

  it("demo case 4: before-photos become baseline, but the uncut section in an AFTER photo still contradicts", async () => {
    const a = await assessment("NS-DEMO-004", "mowing");
    expect(a.status).toBe("CONTRADICTORY");
    expect(a.explanation).toMatch(/NS-DEMO-004-IMG005 shows uncut section visible/);
  });

  it("demo case 9: before and after show different areas → not established, not supported", async () => {
    const pairs = await pairsOf("NS-DEMO-009");
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every((p) => p.status === "NOT_SAME_AREA")).toBe(true);
    const a = await assessment("NS-DEMO-009", "mowing");
    expect(a.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(a.reasons).toContain("BEFORE_AFTER_NOT_ESTABLISHED");
  });

  it("without metadata, photos stay UNKNOWN and before/after is never assumed", async () => {
    expect(await pairsOf("NS-T-UNLABELLED")).toHaveLength(0);
    const a = await assessment("NS-T-UNLABELLED", "mowing");
    expect(a.status).not.toBe("SUPPORTED");
    // Without before-photo labels, the tall grass in the unlabelled before-photo counts against.
    expect(a.status).toBe("CONTRADICTORY");
  });

  it("verifies distinct areas with the model, up to the client's requirement (client C needs 2)", async () => {
    const s = await summaryOf("NS-DEMO-011");
    expect(s.distinctAreas).toBe(2);
    expect(s.areaChecks).toEqual([expect.objectContaining({ result: "DIFFERENT" })]);
  });

  it("demo case 10: reprocessing with the new before-photos establishes before/after, reusing cached comparisons", async () => {
    expect((await assessment("NS-DEMO-010", "mowing")).reasons).toContain("BEFORE_AFTER_NOT_ESTABLISHED");
    const l = await loc("NS-DEMO-010");
    await requestReprocess(t.h.db, t.queue, { locationId: l.id, reason: "NEW_IMAGES", userId: leadId, actor: { type: "SYSTEM" } });
    await t.worker.drain();
    expect((await pairsOf("NS-DEMO-010")).filter((p) => p.status === "CONFIRMED").length).toBeGreaterThan(0);
    const after = await assessment("NS-DEMO-010", "mowing");
    expect(after.reasons).not.toContain("BEFORE_AFTER_NOT_ESTABLISHED");

    const calls = t.vision.pairCalls.length;
    await requestReprocess(t.h.db, t.queue, { locationId: l.id, reason: "TECHNICAL_ERROR", userId: leadId, actor: { type: "SYSTEM" } });
    await t.worker.drain();
    expect(t.vision.pairCalls.length).toBe(calls); // all comparisons came from the cache
    expect((await pairsOf("NS-DEMO-010")).every((p) => p.cacheHit)).toBe(true);
  });
});

describe("GET /api/locations/:id/evidence — pairs", () => {
  it("lists confirmed pairs first with bands and per-service changes", async () => {
    const body = (await app.inject({ url: `/api/locations/${(await loc("NS-DEMO-001")).id}/evidence`, headers: { cookie } })).json();
    expect(body.pairs[0]).toMatchObject({
      status: "CONFIRMED",
      beforeRef: expect.stringMatching(/NS-DEMO-001-IMG/),
      afterRef: expect.stringMatching(/NS-DEMO-001-IMG/),
      sameAreaConfidence: "HIGH",
    });
    expect(body.pairs[0].changes[0]).toMatchObject({ direction: "IMPROVED", strength: "HIGH" });
  });

  it("shows photo stage in the image list", async () => {
    const body = (await app.inject({ url: `/api/locations/${(await loc("NS-DEMO-001")).id}/images`, headers: { cookie } })).json();
    expect(body.items[0].analysis).toMatchObject({ stage: "BEFORE", stageCertainty: "STRONG" });
  });
});
