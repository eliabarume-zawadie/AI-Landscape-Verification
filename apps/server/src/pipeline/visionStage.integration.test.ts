import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { auditEvents, imageAnalysis, images, locations, processingRuns, systemErrors, visionCache } from "../db/schema";
import type { Observation, ValidatedImageAnalysis } from "../domain/observations";
import type { MockScenario } from "../integrations/netsuite/mock/scenarios";
import { requestReprocess, routeToManualReview } from "../services/locationActions";
import { createHarness, scenario, type Harness } from "../test/harness";

let t: Harness;

const loc = async (externalId: string) => (await t.h.db.select().from(locations).where(eq(locations.externalId, externalId)))[0]!;
async function analysis(externalId: string, runId?: string) {
  const l = await loc(externalId);
  const rows = await t.h.db
    .select({ ref: images.externalRef, a: imageAnalysis })
    .from(imageAnalysis)
    .innerJoin(images, eq(images.id, imageAnalysis.imageId))
    .where(eq(imageAnalysis.runId, runId ?? l.currentRunId!))
    .orderBy(asc(images.ordinal));
  return new Map(rows.map((r) => [r.ref, r.a]));
}
const obsOf = (a: { observations: unknown }) => ((a.observations as ValidatedImageAnalysis | null)?.observations ?? []) as Observation[];
async function createLead(): Promise<string> {
  const { createUser } = await import("../services/auth");
  const u = await createUser(
    t.h.db,
    { email: `lead-${Math.random().toString(36).slice(2)}@test.local`, displayName: "Lead", role: "TEAM_LEAD", password: "a-long-test-password" },
    null,
  );
  return u.id;
}

describe("vision stage across mock scenarios", () => {
  beforeAll(async () => {
    t = await createHarness();
    await t.ingest();
    await t.worker.drain();
  });
  afterAll(async () => {
    await t.close();
  });

  it("demo case 1: every image analysed, observations carry registry polarity", async () => {
    const a = await analysis("NS-DEMO-001");
    expect([...a.values()].every((x) => x.analysisStatus === "ANALYZED" && x.servedModel === "mock-vision")).toBe(true);
    const before = obsOf(a.get("NS-DEMO-001-IMG001")!);
    const after = obsOf(a.get("NS-DEMO-001-IMG002")!);
    expect(before.find((o) => o.evidenceType === "tall_overgrown_grass")?.polarity).toBe("negative");
    expect(after.find((o) => o.evidenceType === "maintained_lawn")?.polarity).toBe("positive");
  });

  it("demo case 5: unusable images are never sent to the model", async () => {
    const a = await analysis("NS-DEMO-005");
    expect(a.get("NS-DEMO-005-IMG006")!.analysisStatus).toBe("ANALYZED");
    expect([...a.values()].filter((x) => x.analysisStatus === "SKIPPED_UNUSABLE")).toHaveLength(5);
    expect(t.vision.calls.filter((r) => r.startsWith("NS-DEMO-005"))).toEqual(["NS-DEMO-005-IMG006"]);
  });

  it("demo case 6: only one image per duplicate cluster is analysed", async () => {
    const a = await analysis("NS-DEMO-006");
    expect([...a.values()].filter((x) => x.analysisStatus === "ANALYZED")).toHaveLength(2);
    expect([...a.values()].filter((x) => x.analysisStatus === "SKIPPED_DUPLICATE")).toHaveLength(24);
    expect(t.vision.calls.filter((r) => r.startsWith("NS-DEMO-006"))).toHaveLength(2);
  });

  it("demo case 3: an irrelevant photo becomes unusable, and a hallucinated evidence type is dropped", async () => {
    const a = await analysis("NS-DEMO-003");
    const street = a.get("NS-DEMO-003-IMG004")!;
    expect(street).toMatchObject({ relevant: false, usable: false });
    expect(street.qualityIssues).toContain("IRRELEVANT");
    expect(obsOf(street)).toEqual([]);

    const island = a.get("NS-DEMO-003-IMG003")!;
    expect(island.analysisStatus).toBe("ANALYZED");
    expect(obsOf(island).map((o) => o.evidenceType).sort()).toEqual(["equipment_present", "weeds_reduced"]);
    expect((island.validationWarnings as string[])[0]).toMatch(/service_definitely_completed.*not defined/);
  });

  it("retries a malformed response once and keeps the valid retry (demo case 2)", async () => {
    const a = await analysis("NS-DEMO-002");
    expect(a.get("NS-DEMO-002-IMG012")!.analysisStatus).toBe("ANALYZED");
    expect(t.vision.calls.filter((r) => r === "NS-DEMO-002-IMG012")).toHaveLength(2);
  });

  it("demo case 8: a vision outage is retried, then lands in the Exception Lane as AI_ERROR", async () => {
    const l = await loc("NS-DEMO-008");
    expect(l).toMatchObject({ status: "AI_ERROR", lane: "EXCEPTION" });
    const runs = await t.h.db.select().from(processingRuns).where(eq(processingRuns.locationId, l.id));
    expect(runs).toHaveLength(5);
    expect(runs.every((r) => r.status === "FAILED")).toBe(true);
    const errs = await t.h.db.select().from(systemErrors).where(eq(systemErrors.locationId, l.id));
    expect(errs.some((e) => e.category === "MODEL_ERROR")).toBe(true);

    // The queue can still clear: a team lead sends it to manual review.
    await routeToManualReview(t.h.db, { locationId: l.id, actor: { type: "SYSTEM" } });
    expect((await loc("NS-DEMO-008")).status).toBe("HUMAN_REVIEW");
  });

  it("records provider, model, prompt version and cost on the run, and audits the stage", async () => {
    const l = await loc("NS-DEMO-001");
    const [run] = await t.h.db.select().from(processingRuns).where(eq(processingRuns.id, l.currentRunId!));
    expect(run).toMatchObject({ visionProvider: "mock", visionModel: "mock-vision", aiCostUsd: "0.000000" });
    const [ev] = await t.h.db
      .select({ data: auditEvents.data })
      .from(auditEvents)
      .where(and(eq(auditEvents.runId, run!.id), eq(auditEvents.eventType, "AI_VISION_COMPLETED")));
    expect(ev!.data).toMatchObject({ candidates: 8, analyzed: 8, cached: 0, externalProvider: false, servedModels: ["mock-vision"] });
  });

  it("reuses cached results on reprocessing — no second model call", async () => {
    const l = await loc("NS-DEMO-001");
    const callsBefore = t.vision.calls.length;
    await requestReprocess(t.h.db, t.queue, { locationId: l.id, reason: "TECHNICAL_ERROR", userId: await createLead(), actor: { type: "SYSTEM" } });
    await t.worker.drain();
    expect(t.vision.calls.length).toBe(callsBefore);
    const a = await analysis("NS-DEMO-001");
    expect([...a.values()].every((x) => x.analysisStatus === "CACHED" && x.cacheHit)).toBe(true);
    expect(obsOf(a.get("NS-DEMO-001-IMG002")!).length).toBeGreaterThan(0);
  });

  it("analyses only the new images when more photos arrive (demo case 10)", async () => {
    const l = await loc("NS-DEMO-010");
    const callsBefore = t.vision.calls.filter((r) => r.startsWith("NS-DEMO-010")).length;
    await requestReprocess(t.h.db, t.queue, { locationId: l.id, reason: "NEW_IMAGES", userId: await createLead(), actor: { type: "SYSTEM" } });
    await t.worker.drain();
    const a = await analysis("NS-DEMO-010");
    expect([...a.values()].map((x) => x.analysisStatus).sort()).toEqual(["ANALYZED", "ANALYZED", "CACHED", "CACHED"]);
    expect(t.vision.calls.filter((r) => r.startsWith("NS-DEMO-010")).length - callsBefore).toBe(2);
  });

  it("keys the cache by image content (one entry per distinct analysed image)", async () => {
    const rows = await t.h.db.select().from(visionCache);
    expect(rows.length).toBeGreaterThan(50);
    expect(new Set(rows.map((r) => r.cacheKey)).size).toBe(rows.length);
  });
});

describe("vision stage edge cases", () => {
  afterAll(async () => {
    await t.close();
  });

  const base = scenario("NS-DEMO-001");
  const withImages = (externalId: string, imgs: MockScenario["images"], extra: Partial<MockScenario> = {}): MockScenario => ({
    ...base,
    externalId,
    images: imgs,
    ...extra,
  });

  it("records a refusal without failing the location", async () => {
    t = await createHarness({
      scenarios: [
        withImages("NS-T-REFUSE", [
          { ...base.images[0]!, ref: "R1", visionResponse: "REFUSAL" },
          { ...base.images[1]!, ref: "R2" },
        ]),
      ],
    });
    await t.ingest();
    await t.worker.drain();
    expect((await loc("NS-T-REFUSE")).status).toBe("HUMAN_REVIEW");
    const a = await analysis("NS-T-REFUSE");
    expect(a.get("R1")).toMatchObject({ analysisStatus: "REFUSED", observations: null });
    expect(a.get("R2")!.analysisStatus).toBe("ANALYZED");
  });

  it("sends a location whose every response is malformed to AI_ERROR", async () => {
    await t.close();
    t = await createHarness({ scenarios: [withImages("NS-T-GARBAGE", base.images.slice(0, 2), { failures: { vision: "MALFORMED" } })] });
    await t.ingest();
    await t.worker.drain();
    expect((await loc("NS-T-GARBAGE")).status).toBe("AI_ERROR");
    const a = await analysis("NS-T-GARBAGE", (await t.h.db.select().from(processingRuns))[0]!.id);
    expect([...a.values()].every((x) => x.analysisStatus === "MALFORMED" && x.validationError)).toBe(true);
  });

  it("skips AI entirely at automation level 0", async () => {
    await t.close();
    t = await createHarness({ scenarios: [base], env: { AUTOMATION_LEVEL: "0" } });
    await t.ingest();
    await t.worker.drain();
    const l = await loc("NS-DEMO-001");
    expect(l.status).toBe("HUMAN_REVIEW");
    expect(t.vision.calls).toEqual([]);
    const a = await analysis("NS-DEMO-001");
    expect([...a.values()].every((x) => x.analysisStatus === null)).toBe(true);
  });
});
