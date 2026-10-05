import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, count, eq, sql } from "drizzle-orm";
import {
  auditEvents,
  images,
  locations,
  locationServices,
  processingRuns,
  systemErrors,
  verificationJobs,
} from "../db/schema";
import { requestReprocess, routeToManualReview } from "../services/locationActions";
import { StaleLocationStateError } from "../services/locationTransitions";
import { createHarness, scenario, type Harness } from "../test/harness";
import { JOB_TYPES } from "./jobTypes";

let t: Harness;

const loc = async (externalId: string) => {
  const [row] = await t.h.db.select().from(locations).where(eq(locations.externalId, externalId));
  if (!row) throw new Error(`no location ${externalId}`);
  return row;
};
const runsOf = (locationId: string) =>
  t.h.db.select().from(processingRuns).where(eq(processingRuns.locationId, locationId)).orderBy(asc(processingRuns.runNumber));
const statusTrail = async (locationId: string) =>
  (
    await t.h.db
      .select({ data: auditEvents.data })
      .from(auditEvents)
      .where(and(eq(auditEvents.locationId, locationId), eq(auditEvents.eventType, "LOCATION_STATUS_CHANGED")))
      .orderBy(asc(auditEvents.id))
  ).map((r) => (r.data as { to: string }).to);

describe("queue → location → processing (mock mode)", () => {
  beforeAll(async () => {
    t = await createHarness();
  });
  afterAll(async () => {
    await t.close();
  });

  it("ingests the mock NetSuite queue, routing unverifiable items to the Exception Lane", async () => {
    const summary = await t.ingest();
    expect(summary).toMatchObject({ listed: 16, created: 16, queued: 14, exceptions: 2, alreadyKnown: 0, fetchFailures: 0 });

    const unknownClient = await loc("NS-DEMO-012");
    expect(unknownClient).toMatchObject({ status: "INTEGRATION_ERROR", lane: "EXCEPTION" });
    const unknownService = await loc("NS-DEMO-013");
    expect(unknownService).toMatchObject({ status: "INTEGRATION_ERROR", lane: "EXCEPTION" });

    const errs = await t.h.db.select().from(systemErrors).where(eq(systemErrors.locationId, unknownService.id));
    expect(errs[0]!.message).toMatch(/snow_removal/);
  });

  it("is idempotent when the same queue is ingested again", async () => {
    const again = await t.ingest();
    expect(again).toMatchObject({ created: 0, alreadyKnown: 16 });
    const [{ n } = { n: 0 }] = await t.h.db.select({ n: count() }).from(verificationJobs);
    expect(n).toBe(14);
  });

  it("records required services from the source system, else from the client profile", async () => {
    const fromSource = await t.h.db
      .select({ code: locationServices.serviceCode, source: locationServices.source })
      .from(locationServices)
      .where(eq(locationServices.locationId, (await loc("NS-DEMO-002")).id));
    expect(fromSource.map((s) => s.code).sort()).toEqual(["edging", "mowing", "shrub_pruning", "weed_removal"]);
    expect(fromSource.every((s) => s.source === "SOURCE_SYSTEM")).toBe(true);

    const fromProfile = await t.h.db
      .select({ code: locationServices.serviceCode, source: locationServices.source })
      .from(locationServices)
      .where(eq(locationServices.locationId, (await loc("NS-DEMO-001")).id));
    expect(fromProfile.map((s) => s.code).sort()).toEqual(["edging", "mowing", "shrub_pruning"]);
    expect(fromProfile.every((s) => s.source === "CLIENT_PROFILE")).toBe(true);
  });

  it("processes the queue: every verifiable location reaches human review; nothing is auto-decided", async () => {
    await t.worker.drain();

    const all = await t.h.db.select({ externalId: locations.externalId, status: locations.status, lane: locations.lane }).from(locations);
    const byId = Object.fromEntries(all.map((l) => [l.externalId, l]));

    expect(byId["NS-DEMO-014"]).toMatchObject({ status: "IMAGE_ERROR", lane: "EXCEPTION" }); // no images
    for (const id of ["NS-DEMO-012", "NS-DEMO-013"]) expect(byId[id]!.status).toBe("INTEGRATION_ERROR");
    const reviewable = all.filter((l) => !["NS-DEMO-012", "NS-DEMO-013", "NS-DEMO-014"].includes(l.externalId));
    expect(reviewable).toHaveLength(13);
    for (const l of reviewable) expect(l, l.externalId).toMatchObject({ status: "HUMAN_REVIEW", lane: "HUMAN_REVIEW" });

    expect(all.some((l) => l.status === "APPROVED" || l.status === "REJECTED")).toBe(false);
  });

  it("follows and audits the state machine path", async () => {
    const l = await loc("NS-DEMO-001");
    expect(await statusTrail(l.id)).toEqual(["QUEUED", "DOWNLOADING", "HUMAN_REVIEW"]);
  });

  it("records a versioned run and is honest that no AI analysis ran yet", async () => {
    const l = await loc("NS-DEMO-001");
    const [run] = await runsOf(l.id);
    expect(run).toMatchObject({
      runNumber: 1,
      status: "SUCCEEDED",
      reason: "INITIAL",
      imageCount: 8,
      aiRecommendation: "NEEDS_HUMAN_REVIEW",
      automationLevel: 1,
      applicationVersion: "0.1.0",
    });
    expect(run!.serviceRuleVersionId).not.toBeNull();
    expect(run!.clientProfileId).not.toBeNull();
    expect(run!.thresholdVersionId).not.toBeNull();
    expect(l.currentRunId).toBe(run!.id);

    const [completed] = await t.h.db
      .select({ data: auditEvents.data })
      .from(auditEvents)
      .where(and(eq(auditEvents.runId, run!.id), eq(auditEvents.eventType, "ANALYSIS_COMPLETED")));
    expect(completed!.data).toMatchObject({ aiAnalysisPerformed: false });
  });

  it("stores image references for a 170-image location", async () => {
    const l = await loc("NS-DEMO-016");
    const [{ n } = { n: 0 }] = await t.h.db.select({ n: count() }).from(images).where(eq(images.locationId, l.id));
    expect(n).toBe(170);
  });

  it("retries transient NetSuite failures, keeping a failed run per attempt", async () => {
    const l = await loc("NS-DEMO-015");
    const runs = await runsOf(l.id);
    expect(runs.map((r) => r.status)).toEqual(["FAILED", "FAILED", "SUCCEEDED"]);
    expect(runs[0]!.error).toMatch(/TRANSIENT/);
    expect(l.status).toBe("HUMAN_REVIEW");
    expect(await statusTrail(l.id)).toEqual([
      "QUEUED", "DOWNLOADING", "QUEUED", "DOWNLOADING", "QUEUED", "DOWNLOADING", "HUMAN_REVIEW",
    ]);
  });

  it("routes a no-image location to the Exception Lane with a recorded error", async () => {
    const l = await loc("NS-DEMO-014");
    const errs = await t.h.db.select().from(systemErrors).where(eq(systemErrors.locationId, l.id));
    expect(errs.some((e) => e.category === "INVALID_IMAGE")).toBe(true);
    const [run] = await runsOf(l.id);
    expect(run!.status).toBe("FAILED");
  });

  it("reprocesses with new images, preserving the earlier run (demo case 10)", async () => {
    const l = await loc("NS-DEMO-010");
    await requestReprocess(t.h.db, t.queue, {
      locationId: l.id,
      reason: "NEW_IMAGES",
      note: "before photos uploaded",
      userId: (await createLead()).id,
      actor: { type: "SYSTEM", id: "test" },
    });
    expect((await loc("NS-DEMO-010")).status).toBe("QUEUED");
    await t.worker.drain();

    const runs = await runsOf(l.id);
    expect(runs.map((r) => [r.runNumber, r.status, r.imageCount, r.reason])).toEqual([
      [1, "SUCCEEDED", 2, "INITIAL"],
      [2, "SUCCEEDED", 4, "REPROCESS:NEW_IMAGES"],
    ]);
    const after = await loc("NS-DEMO-010");
    expect(after.currentRunId).toBe(runs[1]!.id);
    expect(after.status).toBe("HUMAN_REVIEW");

    const [reqEvent] = await t.h.db
      .select({ data: auditEvents.data })
      .from(auditEvents)
      .where(and(eq(auditEvents.locationId, l.id), eq(auditEvents.eventType, "REPROCESS_REQUESTED")));
    expect(reqEvent!.data).toMatchObject({ reason: "NEW_IMAGES", previousRunId: runs[0]!.id });
  });

  it("refuses to reprocess while a decision is waiting to sync", async () => {
    const l = await loc("NS-DEMO-001");
    await t.h.db.update(locations).set({ status: "SYNCING" }).where(eq(locations.id, l.id));
    await expect(
      requestReprocess(t.h.db, t.queue, {
        locationId: l.id,
        reason: "REVIEWER_DISPUTE",
        userId: (await createLead()).id,
        actor: { type: "SYSTEM" },
      }),
    ).rejects.toBeInstanceOf(StaleLocationStateError);
    await t.h.db.update(locations).set({ status: "HUMAN_REVIEW" }).where(eq(locations.id, l.id));
  });

  it("lets a team lead send an exception to manual review (fallback)", async () => {
    const l = await loc("NS-DEMO-014");
    await routeToManualReview(t.h.db, { locationId: l.id, note: "check with crew", actor: { type: "SYSTEM" } });
    expect(await loc("NS-DEMO-014")).toMatchObject({ status: "HUMAN_REVIEW", lane: "HUMAN_REVIEW" });
    await expect(routeToManualReview(t.h.db, { locationId: l.id, actor: { type: "SYSTEM" } })).rejects.toBeInstanceOf(
      StaleLocationStateError,
    );
  });
});

describe("crash recovery", () => {
  beforeAll(async () => {
    t = await createHarness({ scenarios: [scenario("NS-DEMO-001")] });
  });
  afterAll(async () => {
    await t.close();
  });

  it("restarts a location whose worker died mid-processing, without duplicating work", async () => {
    await t.ingest();

    // A worker claims the job, starts the run, then "crashes" (never completes).
    const [claimed] = await t.queue.claim("crashed", [JOB_TYPES.PROCESS_LOCATION], 1, 60_000);
    const l = await loc("NS-DEMO-001");
    await t.h.db.insert(processingRuns).values({
      locationId: l.id,
      runNumber: 1,
      reason: "INITIAL",
      automationLevel: 1,
      shadowMode: false,
      applicationVersion: "0.1.0",
    });
    await t.h.db.update(locations).set({ status: "DOWNLOADING" }).where(eq(locations.id, l.id));
    await t.h.db.execute(sql`update verification_jobs set locked_until = now() - interval '1 second' where id = ${claimed!.id}`);

    await t.worker.drain();

    const runs = await runsOf(l.id);
    expect(runs.map((r) => r.status)).toEqual(["FAILED", "SUCCEEDED"]);
    expect(runs[0]!.error).toMatch(/interrupted/);
    expect((await loc("NS-DEMO-001")).status).toBe("HUMAN_REVIEW");
    const [job] = await t.h.db.select().from(verificationJobs).where(eq(verificationJobs.id, claimed!.id));
    expect(job).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
  });
});

async function createLead() {
  const { createUser } = await import("../services/auth");
  return createUser(
    t.h.db,
    { email: `lead-${Math.random().toString(36).slice(2)}@test.local`, displayName: "Lead", role: "TEAM_LEAD", password: "a-long-test-password" },
    null,
  );
}
