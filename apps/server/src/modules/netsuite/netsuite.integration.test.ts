import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { auditEvents, humanReviews, locations, netsuiteSyncOutbox, systemErrors, verificationJobs } from "../../db/schema";
import { buildApp } from "../../http/app";
import { SESSION_COOKIE } from "../../http/authPlugin";
import { IntegrationError } from "../../integrations/netsuite/NetSuiteAdapter";
import { createUser, LoginThrottle } from "../../services/auth";
import { noteBody, queueUnsyncedDecisions, serviceDecisionsFor, verificationKey, type VerificationPayload } from "../../services/netsuiteSync";
import { createHarness, scenario, type Harness } from "../../test/harness";

let t: Harness;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const PW = "a-long-test-password";
const as = (who: string) => ({ cookie: cookies[who]! });
const loc = async (externalId: string) => (await t.h.db.select().from(locations).where(eq(locations.externalId, externalId)))[0]!;
const review = async (who: string, externalId: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/locations/${(await loc(externalId)).id}/review`, headers: as(who), payload });
const outbox = async (externalId: string) => t.h.db.select().from(netsuiteSyncOutbox).where(eq(netsuiteSyncOutbox.locationId, (await loc(externalId)).id));
const audits = async (externalId: string, type: string) =>
  t.h.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.locationId, (await loc(externalId)).id), sql`${auditEvents.eventType} = ${type}`));
const writesFor = (externalId: string) => [...t.netsuite.verificationWrites.values()].filter((w) => w.externalId === externalId);

beforeAll(async () => {
  t = await createHarness({
    scenarios: ["NS-DEMO-001", "NS-DEMO-002", "NS-DEMO-003", "NS-DEMO-004", "NS-DEMO-007", "NS-DEMO-009", "NS-DEMO-011"].map(scenario),
  });
  app = await buildApp({ env: t.env, db: t.h.db, loginThrottle: new LoginThrottle(), ...t.runtime });
  for (const [who, role] of [["reviewer", "REVIEWER"], ["lead", "TEAM_LEAD"]] as const) {
    await createUser(t.h.db, { email: `${who}@test.local`, displayName: who === "reviewer" ? "Riley Reviewer" : "Lee Lead", role, password: PW }, null);
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

describe("message building", () => {
  it("per-service decisions cover every assessed service; the location decision unless split", () => {
    expect(
      serviceDecisionsFor({ decision: "APPROVE", serviceDecisions: {}, aiSnapshot: { services: { mowing: {}, edging: {} } } }),
    ).toEqual({ edging: "APPROVE", mowing: "APPROVE" });
    expect(serviceDecisionsFor({ decision: "REJECT", serviceDecisions: { mowing: "REJECT" }, aiSnapshot: null })).toEqual({ mowing: "REJECT" });
  });
  it("writes a note only when there is a reason, in plain words", () => {
    const at = new Date("2026-10-05T15:17:00Z");
    expect(noteBody({ decision: "APPROVE", isOverride: false, reasonCode: null, reasonText: null, submittedAt: at }, "Riley", 2)).toBeNull();
    expect(noteBody({ decision: "APPROVE", isOverride: true, reasonCode: "AI_MISSED_EVIDENCE", reasonText: "Lawns are contiguous.", submittedAt: at }, "Riley", 2)).toBe(
      "ALVIP verification: Approved by Riley on 2026-10-05 15:17 UTC. The reviewer decided against the AI assessment. Reason: AI missed evidence. Note: Lawns are contiguous. Processing run 2.",
    );
  });
});

describe("decision → NetSuite (PRD §37–39)", () => {
  it("a decision commits its outbox write and sync job together; the worker sends it and completes the location", async () => {
    const res = await review("reviewer", "NS-DEMO-002", { decision: "APPROVE" });
    expect(res.json().status).toBe("APPROVED");
    const [row] = await outbox("NS-DEMO-002");
    expect(row).toMatchObject({ operation: "UPDATE_VERIFICATION", status: "PENDING", idempotencyKey: verificationKey(res.json().reviewId) });
    expect((await outbox("NS-DEMO-002")).filter((r) => r.operation === "ADD_NOTE")).toHaveLength(0); // no reason, no note
    const [job] = await t.h.db.select().from(verificationJobs).where(eq(verificationJobs.idempotencyKey, `netsuite-sync:${res.json().reviewId}`));
    expect(job!.status).toBe("PENDING");

    await t.worker.drain();
    expect((await loc("NS-DEMO-002")).status).toBe("COMPLETED");
    const [done] = await outbox("NS-DEMO-002");
    expect(done).toMatchObject({ status: "SUCCEEDED", attempts: 1, alreadyApplied: false, remoteRef: expect.stringMatching(/^MOCK-VERIFY-/) });
    const [w] = writesFor("NS-DEMO-002");
    expect(w!.write).toMatchObject({ decision: "APPROVE", reviewerName: "Riley Reviewer", serviceDecisions: { mowing: "APPROVE" } });
    expect(w!.write.processingRunId).not.toBeNull();
    const path = (await audits("NS-DEMO-002", "LOCATION_STATUS_CHANGED")).map((a) => (a.data as { to: string }).to).slice(-4);
    expect(path).toEqual(["APPROVED", "SYNCING", "SYNCED_TO_NETSUITE", "COMPLETED"]);
    expect(await audits("NS-DEMO-002", "NETSUITE_SYNC_SUCCEEDED")).toHaveLength(1);
  });

  it("an override with a reason also adds a NetSuite note", async () => {
    await review("reviewer", "NS-DEMO-009", { decision: "APPROVE", reasonCode: "AI_MISSED_EVIDENCE", reasonText: "Lawns are contiguous." });
    await t.worker.drain();
    expect((await loc("NS-DEMO-009")).status).toBe("COMPLETED");
    const note = [...t.netsuite.notes.values()].find((n) => n.externalId === "NS-DEMO-009")!;
    expect(note.note.body).toMatch(/^ALVIP verification: Approved by Riley Reviewer .* against the AI assessment\. Reason: AI missed evidence\. Note: Lawns are contiguous\./);
    expect((await outbox("NS-DEMO-009")).map((r) => r.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
  });

  it("transient NetSuite failures are retried with backoff until they succeed, without duplicate writes (demo case 7)", async () => {
    await review("reviewer", "NS-DEMO-007", { decision: "APPROVE", reasonCode: "OTHER", reasonText: "Confirmed on site." });
    await t.worker.runOnce();
    expect((await loc("NS-DEMO-007")).status).toBe("SYNCING"); // retry scheduled, decision kept
    const [failed] = (await outbox("NS-DEMO-007")).filter((r) => r.operation === "UPDATE_VERIFICATION");
    expect(failed).toMatchObject({ status: "FAILED", lastErrorCategory: "TRANSIENT" });

    await t.worker.drain();
    expect((await loc("NS-DEMO-007")).status).toBe("COMPLETED");
    const verify = (await outbox("NS-DEMO-007")).find((r) => r.operation === "UPDATE_VERIFICATION")!;
    expect(verify).toMatchObject({ status: "SUCCEEDED", attempts: 4, lastError: null });
    expect(writesFor("NS-DEMO-007")).toHaveLength(1);
    const failures = await audits("NS-DEMO-007", "NETSUITE_SYNC_FAILED");
    expect(failures.map((f) => (f.data as { outcome: string }).outcome)).toEqual(["RETRY", "RETRY", "RETRY"]);
    // Resolved errors no longer show as open problems.
    const open = await t.h.db.select().from(systemErrors).where(and(eq(systemErrors.locationId, (await loc("NS-DEMO-007")).id), sql`${systemErrors.resolvedAt} is null`));
    expect(open).toHaveLength(0);
  });

  it("a validation error stops at once (no endless retries); a team lead retries after fixing it", async () => {
    const original = t.netsuite.updateVerification.bind(t.netsuite);
    t.netsuite.updateVerification = async () => {
      throw new IntegrationError("Mock NetSuite: field custrecord_status rejected value", "NETSUITE_VALIDATION");
    };
    try {
      await review("reviewer", "NS-DEMO-003", { decision: "REJECT" });
      await t.worker.drain();
    } finally {
      t.netsuite.updateVerification = original;
    }
    const l = await loc("NS-DEMO-003");
    expect(l).toMatchObject({ status: "NETSUITE_ERROR", lane: "EXCEPTION" });
    const [row] = await outbox("NS-DEMO-003");
    expect(row).toMatchObject({ status: "DEAD", attempts: 1, lastErrorCategory: "NETSUITE_VALIDATION" });
    expect((await t.h.db.select().from(humanReviews).where(eq(humanReviews.locationId, l.id)))[0]!.decision).toBe("REJECT"); // decision kept

    const url = `/api/locations/${l.id}/netsuite/retry`;
    expect((await app.inject({ method: "POST", url, headers: as("reviewer") })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: as("lead") })).statusCode).toBe(202);
    expect(await audits("NS-DEMO-003", "NETSUITE_SYNC_RETRY_REQUESTED")).toHaveLength(1);
    await t.worker.drain();
    expect((await loc("NS-DEMO-003")).status).toBe("COMPLETED");
    expect((await outbox("NS-DEMO-003"))[0]).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect((await app.inject({ method: "POST", url, headers: as("lead") })).statusCode).toBe(409);

    const view = (await app.inject({ url: `/api/locations/${l.id}/netsuite`, headers: as("reviewer") })).json();
    expect(view.writes[0]).toMatchObject({ operation: "UPDATE_VERIFICATION", status: "SUCCEEDED", attempts: 2 });
  });

  it("never overwrites a decision someone recorded in NetSuite directly", async () => {
    t.netsuite.recordDecisionOutsideAlvip("NS-DEMO-001", "REJECT");
    await review("reviewer", "NS-DEMO-001", { decision: "APPROVE", reasonCode: "CLIENT_SPECIFIC_RULE" });
    await t.worker.drain();
    expect((await loc("NS-DEMO-001")).status).toBe("NETSUITE_ERROR");
    const [row] = (await outbox("NS-DEMO-001")).filter((r) => r.operation === "UPDATE_VERIFICATION");
    expect(row).toMatchObject({ status: "DEAD", lastErrorCategory: "NETSUITE_VALIDATION", attempts: 0 });
    expect(row!.lastError).toMatch(/already shows "REJECT".*outside ALVIP/);
    expect(writesFor("NS-DEMO-001").map((w) => w.write.decision)).toEqual(["REJECT"]); // untouched
  });

  it("after a crash between the NetSuite write and our bookkeeping, the retry is recognised, not duplicated", async () => {
    const res = await review("reviewer", "NS-DEMO-004", { decision: "REJECT" });
    const key = verificationKey(res.json().reviewId);
    // The previous attempt reached NetSuite, then the worker died before recording success.
    const [row] = await outbox("NS-DEMO-004");
    await t.netsuite.updateVerification("NS-DEMO-004", { ...(row!.payload as VerificationPayload), decidedAt: new Date(), idempotencyKey: key });
    await t.worker.drain();
    expect((await loc("NS-DEMO-004")).status).toBe("COMPLETED");
    expect((await outbox("NS-DEMO-004"))[0]).toMatchObject({ status: "SUCCEEDED", alreadyApplied: true });
    expect(writesFor("NS-DEMO-004")).toHaveLength(1);
  });

  it("escalation is internal: nothing is sent to NetSuite", async () => {
    const res = await review("reviewer", "NS-DEMO-011", { decision: "ESCALATE" });
    expect(res.json().status).toBe("ESCALATED");
    expect(await outbox("NS-DEMO-011")).toHaveLength(0);
  });

  it("the sweep queues decisions that have no sync yet (e.g. made before write-back existed), once", async () => {
    await review("lead", "NS-DEMO-011", { decision: "REJECT" });
    const id = (await loc("NS-DEMO-011")).id;
    // Simulate a decision recorded before Phase 11: no outbox rows, no job.
    await t.h.db.delete(netsuiteSyncOutbox).where(eq(netsuiteSyncOutbox.locationId, id));
    await t.h.db.delete(verificationJobs).where(and(eq(verificationJobs.locationId, id), eq(verificationJobs.type, "NETSUITE_SYNC")));
    expect(await queueUnsyncedDecisions(t.h.db, t.queue, { maxAttempts: 8 })).toBe(1);
    expect(await queueUnsyncedDecisions(t.h.db, t.queue, { maxAttempts: 8 })).toBe(0);
    await t.worker.drain();
    expect((await loc("NS-DEMO-011")).status).toBe("COMPLETED");
    expect(writesFor("NS-DEMO-011").map((w) => w.write.decision)).toEqual(["REJECT"]);
  });
});
