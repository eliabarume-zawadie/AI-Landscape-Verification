import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { auditEvents, imageAnalysis, images, locations, processingRuns } from "../db/schema";
import { ImageFetchError, type FetchedImage, type ImageProvider } from "../integrations/images/ImageProvider";
import { MockImageProvider } from "../integrations/images/mock/MockImageProvider";
import { MOCK_SCENARIOS, type MockScenario } from "../integrations/netsuite/mock/scenarios";
import { requestReprocess } from "../services/locationActions";
import { purgeExpiredImages } from "../services/retention";
import { createHarness, scenario, type Harness } from "../test/harness";

let t: Harness;

const loc = async (externalId: string) => {
  const [row] = await t.h.db.select().from(locations).where(eq(locations.externalId, externalId));
  return row!;
};
/** Analysis rows for the location's current run, keyed by image external ref. */
async function analysisOf(externalId: string) {
  const l = await loc(externalId);
  const rows = await t.h.db
    .select({ ref: images.externalRef, a: imageAnalysis })
    .from(imageAnalysis)
    .innerJoin(images, eq(images.id, imageAnalysis.imageId))
    .where(eq(imageAnalysis.runId, l.currentRunId!))
    .orderBy(asc(images.ordinal));
  return new Map(rows.map((r) => [r.ref, r.a]));
}

describe("image stage across all mock scenarios", () => {
  beforeAll(async () => {
    t = await createHarness();
    await t.ingest();
    await t.worker.drain();
  });
  afterAll(async () => {
    await t.close();
  });

  it("still routes every readable location to human review (no AI decisions yet)", async () => {
    const all = await t.h.db.select({ id: locations.externalId, status: locations.status }).from(locations);
    const statuses = Object.fromEntries(all.map((l) => [l.id, l.status]));
    expect(statuses["NS-DEMO-005"]).toBe("HUMAN_REVIEW"); // one usable image remains
    expect(statuses["NS-DEMO-014"]).toBe("IMAGE_ERROR");
    expect(all.filter((l) => l.status === "HUMAN_REVIEW")).toHaveLength(13);
  });

  it("stores bytes privately and records hashes and dimensions", async () => {
    const l = await loc("NS-DEMO-001");
    const rows = await t.h.db.select().from(images).where(eq(images.locationId, l.id));
    for (const r of rows) {
      expect(r.storageKey).toBe(`locations/${l.id}/${r.id}`);
      expect(t.storage.objects.has(r.storageKey!)).toBe(true);
      expect(r).toMatchObject({ format: "jpeg", width: 800, height: 600 });
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.perceptualHash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("demo case 1: all 8 images usable and distinct", async () => {
    const a = await analysisOf("NS-DEMO-001");
    expect([...a.values()].every((x) => x.usable && x.isDuplicateRepresentative)).toBe(true);
    const [run] = await t.h.db.select().from(processingRuns).where(eq(processingRuns.id, (await loc("NS-DEMO-001")).currentRunId!));
    expect(run).toMatchObject({ imageCount: 8, uniqueImageCount: 8 });
  });

  it("demo case 5: detects each pixel-level defect and keeps the good image", async () => {
    const a = await analysisOf("NS-DEMO-005");
    const issues = (ref: string) => a.get(`NS-DEMO-005-${ref}`)!.qualityIssues as string[];
    expect(issues("IMG001")).toContain("BLURRY");
    expect(issues("IMG002")).toContain("TOO_DARK");
    expect(issues("IMG003")).toContain("OVEREXPOSED");
    expect(issues("IMG004")).toEqual(["CORRUPT"]);
    expect(issues("IMG005")).toContain("TOO_SMALL");
    expect(a.get("NS-DEMO-005-IMG006")).toMatchObject({ usable: true, qualityIssues: [] });
    expect([...a.values()].filter((x) => x.usable)).toHaveLength(1);
  });

  it("demo case 6: 25 near-identical photos count as one cluster", async () => {
    const a = await analysisOf("NS-DEMO-006");
    const afterGroup = a.get("NS-DEMO-006-IMG002")!.duplicateGroup;
    const inGroup = [...a.values()].filter((x) => x.duplicateGroup === afterGroup);
    expect(inGroup).toHaveLength(25);
    expect(inGroup.filter((x) => x.isDuplicateRepresentative)).toHaveLength(1);
    expect(inGroup.filter((x) => x.duplicateKind === "NEAR")).toHaveLength(24);
    expect(a.get("NS-DEMO-006-IMG001")!.duplicateGroup).not.toBe(afterGroup); // before stays separate
    const [run] = await t.h.db.select().from(processingRuns).where(eq(processingRuns.id, (await loc("NS-DEMO-006")).currentRunId!));
    expect(run!.uniqueImageCount).toBe(2);
  });

  it("never merges before and after photos, or different scenes, in any scenario", async () => {
    const specByRef = new Map(
      MOCK_SCENARIOS.flatMap((s) => [...s.images, ...(s.imagesAddedLater ?? [])]).map((i) => [i.ref, i]),
    );
    const rows = await t.h.db
      .select({ ref: images.externalRef, group: imageAnalysis.duplicateGroup })
      .from(imageAnalysis)
      .innerJoin(images, eq(images.id, imageAnalysis.imageId));
    const groups = new Map<string, Set<string>>();
    for (const r of rows) {
      const spec = specByRef.get(r.ref)!;
      const key = `${spec.scene}:${spec.stage}`;
      groups.set(r.group!, (groups.get(r.group!) ?? new Set()).add(key));
    }
    for (const [group, kinds] of groups) expect([...kinds], group).toHaveLength(1);
  });

  it("processes the 170-image location", async () => {
    const a = await analysisOf("NS-DEMO-016");
    expect(a.size).toBe(170);
    const [run] = await t.h.db.select().from(processingRuns).where(eq(processingRuns.id, (await loc("NS-DEMO-016")).currentRunId!));
    expect(run!.uniqueImageCount).toBeGreaterThanOrEqual(150);
    expect(run!.uniqueImageCount).toBeLessThanOrEqual(170);
  });

  it("audits quality results with the thresholds version used", async () => {
    const l = await loc("NS-DEMO-005");
    const [ev] = await t.h.db
      .select({ data: auditEvents.data })
      .from(auditEvents)
      .where(and(eq(auditEvents.runId, l.currentRunId!), eq(auditEvents.eventType, "IMAGE_QUALITY_ASSESSED")));
    expect(ev!.data).toMatchObject({ total: 6, usable: 1, readable: 5, thresholdsVersion: "thresholds-v2" });
  });

  it("reuses stored bytes when reprocessing (only new images are fetched)", async () => {
    const l = await loc("NS-DEMO-010");
    const lead = await createLead();
    await requestReprocess(t.h.db, t.queue, { locationId: l.id, reason: "NEW_IMAGES", userId: lead, actor: { type: "SYSTEM" } });
    await t.worker.drain();
    const after = await loc("NS-DEMO-010");
    const [ev] = await t.h.db
      .select({ data: auditEvents.data })
      .from(auditEvents)
      .where(and(eq(auditEvents.runId, after.currentRunId!), eq(auditEvents.eventType, "IMAGES_DOWNLOADED")));
    expect(ev!.data).toMatchObject({ totalImages: 4, fetched: 2, reusedFromStorage: 2 });
    // Run 1's analysis is preserved alongside run 2's.
    const runs = await t.h.db.select({ id: processingRuns.id }).from(processingRuns).where(eq(processingRuns.locationId, l.id));
    for (const r of runs) {
      const rows = await t.h.db.select().from(imageAnalysis).where(eq(imageAnalysis.runId, r.id));
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it("purges image bytes past retention only for finished locations", async () => {
    const done = await loc("NS-DEMO-001");
    const inReview = await loc("NS-DEMO-002");
    await t.h.db.update(locations).set({ status: "COMPLETED" }).where(eq(locations.id, done.id));
    await t.h.db.execute(sql`update images set downloaded_at = now() - interval '40 days' where location_id in (${done.id}, ${inReview.id})`);

    const r = await purgeExpiredImages(t.h.db, t.storage, { retentionDays: 30, actor: { type: "SYSTEM" } });
    expect(r).toEqual({ purged: 8, locations: 1 });

    const purged = await t.h.db.select().from(images).where(eq(images.locationId, done.id));
    expect(purged.every((i) => i.purgedAt && i.storageKey === null && i.sha256)).toBe(true); // hashes kept
    expect([...t.storage.objects.keys()].some((k) => k.includes(done.id))).toBe(false);
    const kept = await t.h.db.select().from(images).where(eq(images.locationId, inReview.id));
    expect(kept.every((i) => i.purgedAt === null)).toBe(true);
    expect((await purgeExpiredImages(t.h.db, t.storage, { retentionDays: 30, actor: { type: "SYSTEM" } })).purged).toBe(0);
  });
});

describe("image stage failure handling", () => {
  afterAll(async () => {
    await t.close();
  });

  it("sends a location with no readable image to the Exception Lane", async () => {
    const base = scenario("NS-DEMO-001");
    const broken: MockScenario = {
      ...base,
      externalId: "NS-TEST-BROKEN",
      images: [
        { ...base.images[0]!, ref: "B1", defects: ["corrupt"] },
        { ...base.images[1]!, ref: "B2", defects: ["missing"] },
        { ...base.images[2]!, ref: "B3", defects: ["unsupported_format"] },
      ],
    };
    t = await createHarness({ scenarios: [broken] });
    await t.ingest();
    await t.worker.drain();
    const l = await loc("NS-TEST-BROKEN");
    expect(l).toMatchObject({ status: "IMAGE_ERROR", lane: "EXCEPTION" });
    const a = await t.h.db
      .select({ ref: images.externalRef, issues: imageAnalysis.qualityIssues, err: images.downloadError })
      .from(imageAnalysis)
      .innerJoin(images, eq(images.id, imageAnalysis.imageId))
      .orderBy(asc(images.externalRef));
    expect(a.map((x) => [x.ref, x.issues])).toEqual([
      ["B1", ["CORRUPT"]],
      ["B2", ["MISSING"]],
      ["B3", ["UNSUPPORTED_FORMAT"]],
    ]);
    expect(a[1]!.err).toMatch(/NOT_FOUND/);
  });

  it("retries a transient image fetch failure and keeps bytes already fetched", async () => {
    await t.close();
    const one = scenario("NS-DEMO-001");
    t = await createHarness({ scenarios: [one] });
    const real = new MockImageProvider([one]);
    let failedOnce = false;
    const flaky: ImageProvider = {
      name: "flaky",
      async fetch(locator): Promise<FetchedImage> {
        if (locator.endsWith("IMG005") && !failedOnce) {
          failedOnce = true;
          throw new ImageFetchError("socket hang up", "TRANSIENT");
        }
        return real.fetch(locator);
      },
    };
    t.runtime.integrations.images = flaky;
    await t.ingest();
    await t.worker.drain();

    const l = await loc("NS-DEMO-001");
    expect(l.status).toBe("HUMAN_REVIEW");
    const runs = await t.h.db.select().from(processingRuns).where(eq(processingRuns.locationId, l.id)).orderBy(asc(processingRuns.runNumber));
    expect(runs.map((r) => r.status)).toEqual(["FAILED", "SUCCEEDED"]);
    const [ev] = await t.h.db
      .select({ data: auditEvents.data })
      .from(auditEvents)
      .where(and(eq(auditEvents.runId, runs[1]!.id), eq(auditEvents.eventType, "IMAGES_DOWNLOADED")));
    // The 7 images fetched before the failure are reused; only the failed one is fetched again.
    expect(ev!.data).toMatchObject({ fetched: 1, reusedFromStorage: 7 });
  });
});

async function createLead(): Promise<string> {
  const { createUser } = await import("../services/auth");
  const u = await createUser(
    t.h.db,
    { email: `lead-${Math.random().toString(36).slice(2)}@test.local`, displayName: "Lead", role: "TEAM_LEAD", password: "a-long-test-password" },
    null,
  );
  return u.id;
}
