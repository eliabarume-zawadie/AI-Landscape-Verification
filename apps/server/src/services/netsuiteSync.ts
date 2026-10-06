import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { ReviewDecision } from "@alvip/shared";
import { recordAudit, type Actor } from "../audit/audit";
import type { Db } from "../db/client";
import { humanReviews, locations, netsuiteSyncOutbox, processingRuns, systemErrors, users } from "../db/schema";
import { IntegrationError, type NetSuiteAdapter, type VerificationWrite } from "../integrations/netsuite/NetSuiteAdapter";
import type { QueueProvider } from "../integrations/queue/QueueProvider";
import type { JobHandler } from "../pipeline/jobHandler";
import { JOB_TYPES, type NetSuiteSyncPayload } from "../pipeline/jobTypes";
import { REASON_TEXT } from "./reasonText";
import { LocationNotFoundError, StaleLocationStateError, transitionLocation } from "./locationTransitions";

/**
 * NetSuite write-back (PRD §37–39) through a transactional outbox.
 *
 *  1. The human decision, its outbox rows and the sync job are written in ONE transaction,
 *     so a decision can never be lost between "decided" and "sent".
 *  2. The sync job re-reads the NetSuite record first and refuses to overwrite a decision
 *     that someone recorded in NetSuite directly.
 *  3. Every write carries an idempotency key, so a retry after a crash cannot duplicate it.
 *  4. PRD §78: TRANSIENT → retry with backoff; AUTHENTICATION / NETSUITE_VALIDATION /
 *     CONFIGURATION → stop at once, location to NETSUITE_ERROR (Exception Lane) until a
 *     team lead retries after fixing the cause.
 */

export const OPERATIONS = { VERIFY: "UPDATE_VERIFICATION", NOTE: "ADD_NOTE" } as const;
const FINAL_DECISIONS: readonly ReviewDecision[] = ["APPROVE", "REJECT"];
const DECISION_WORD: Record<string, string> = { APPROVE: "Approved", REJECT: "Rejected" };

type Review = typeof humanReviews.$inferSelect;
export type VerificationPayload = Omit<VerificationWrite, "idempotencyKey" | "decidedAt"> & { decidedAt: string };

export function verificationKey(reviewId: string) {
  return `netsuite:verification:${reviewId}`;
}
export function noteKey(reviewId: string) {
  return `netsuite:note:${reviewId}`;
}

/** Per-service decisions for every required service the AI assessed (the location decision unless split). */
export function serviceDecisionsFor(review: Pick<Review, "decision" | "serviceDecisions" | "aiSnapshot">): Record<string, ReviewDecision> {
  const split = (review.serviceDecisions ?? {}) as Record<string, ReviewDecision>;
  const assessed = Object.keys(((review.aiSnapshot ?? {}) as { services?: Record<string, unknown> }).services ?? {});
  return Object.fromEntries([...new Set([...assessed, ...Object.keys(split)])].sort().map((s) => [s, split[s] ?? review.decision]));
}

/** Plain-text NetSuite note. Only written when the reviewer gave a reason or note. */
export function noteBody(review: Pick<Review, "decision" | "isOverride" | "reasonCode" | "reasonText" | "submittedAt">, reviewerName: string, runNumber: number | null): string | null {
  if (!review.reasonCode && !review.reasonText) return null;
  const parts = [
    `ALVIP verification: ${DECISION_WORD[review.decision] ?? review.decision} by ${reviewerName} on ${review.submittedAt.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
    review.isOverride ? "The reviewer decided against the AI assessment." : null,
    review.reasonCode ? `Reason: ${REASON_TEXT[review.reasonCode] ?? review.reasonCode}.` : null,
    review.reasonText ? `Note: ${review.reasonText}` : null,
    runNumber ? `Processing run ${runNumber}.` : null,
  ];
  return parts.filter(Boolean).join(" ");
}

/**
 * Write the outbox rows for a final decision and enqueue the sync job. Pass the transaction
 * that records the decision. Idempotent: re-running for the same review is a no-op.
 */
export async function queueDecisionSync(tx: Db, queue: QueueProvider, review: Review, opts: { maxAttempts: number }): Promise<void> {
  if (!FINAL_DECISIONS.includes(review.decision)) return;
  const [who] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, review.reviewerId));
  const [run] = review.runId ? await tx.select({ n: processingRuns.runNumber }).from(processingRuns).where(eq(processingRuns.id, review.runId)) : [];
  const reviewerName = who?.name ?? "ALVIP reviewer";

  const verification: VerificationPayload = {
    decision: review.decision,
    reviewerName,
    decidedAt: review.submittedAt.toISOString(),
    processingRunId: review.runId,
    serviceDecisions: serviceDecisionsFor(review),
  };
  const rows: (typeof netsuiteSyncOutbox.$inferInsert)[] = [
    { locationId: review.locationId, reviewId: review.id, operation: OPERATIONS.VERIFY, payload: verification, idempotencyKey: verificationKey(review.id) },
  ];
  const body = noteBody(review, reviewerName, run?.n ?? null);
  if (body) rows.push({ locationId: review.locationId, reviewId: review.id, operation: OPERATIONS.NOTE, payload: { body }, idempotencyKey: noteKey(review.id) });
  await tx.insert(netsuiteSyncOutbox).values(rows).onConflictDoNothing();

  await queue.enqueue(
    {
      type: JOB_TYPES.NETSUITE_SYNC,
      payload: { locationId: review.locationId, reviewId: review.id } satisfies NetSuiteSyncPayload,
      idempotencyKey: `netsuite-sync:${review.id}`,
      locationId: review.locationId,
      maxAttempts: opts.maxAttempts,
    },
    tx,
  );
}

/**
 * Safety net, run periodically: any APPROVED/REJECTED location whose decision has no sync
 * job yet gets one (e.g. decisions recorded before write-back existed). Idempotent.
 */
export async function queueUnsyncedDecisions(db: Db, queue: QueueProvider, opts: { maxAttempts: number; limit?: number }): Promise<number> {
  const waiting = await db
    .select({ id: locations.id })
    .from(locations)
    .where(inArray(locations.status, ["APPROVED", "REJECTED"]))
    .limit(opts.limit ?? 200);
  let queued = 0;
  for (const { id } of waiting) {
    const [review] = await db
      .select()
      .from(humanReviews)
      .where(and(eq(humanReviews.locationId, id), inArray(humanReviews.decision, [...FINAL_DECISIONS])))
      .orderBy(desc(humanReviews.submittedAt))
      .limit(1);
    if (!review) continue;
    const [existing] = await db.select({ id: netsuiteSyncOutbox.id }).from(netsuiteSyncOutbox).where(eq(netsuiteSyncOutbox.reviewId, review.id)).limit(1);
    if (existing) continue;
    await db.transaction((tx) => queueDecisionSync(tx, queue, review, opts));
    queued++;
  }
  return queued;
}

/**
 * The decision NetSuite should currently show if nobody changed it outside ALVIP: the
 * last decision ALVIP synced for this location (null if none).
 */
async function lastSyncedDecision(db: Db, locationId: string, excludeReviewId: string): Promise<string | null> {
  const [row] = await db
    .select({ payload: netsuiteSyncOutbox.payload })
    .from(netsuiteSyncOutbox)
    .where(
      and(
        eq(netsuiteSyncOutbox.locationId, locationId),
        eq(netsuiteSyncOutbox.operation, OPERATIONS.VERIFY),
        eq(netsuiteSyncOutbox.status, "SUCCEEDED"),
        ne(netsuiteSyncOutbox.reviewId, excludeReviewId),
      ),
    )
    .orderBy(desc(netsuiteSyncOutbox.syncedAt))
    .limit(1);
  return (row?.payload as VerificationPayload | undefined)?.decision ?? null;
}

export async function syncDecision(db: Db, netsuite: NetSuiteAdapter, payload: NetSuiteSyncPayload, actor: Actor): Promise<"SYNCED" | "NOTHING_TO_DO"> {
  const [loc] = await db.select({ id: locations.id, externalId: locations.externalId, status: locations.status }).from(locations).where(eq(locations.id, payload.locationId));
  if (!loc) throw new LocationNotFoundError(`Location ${payload.locationId} not found`);

  const pending = await db
    .select()
    .from(netsuiteSyncOutbox)
    .where(and(eq(netsuiteSyncOutbox.reviewId, payload.reviewId), ne(netsuiteSyncOutbox.status, "SUCCEEDED")))
    // Verification before the note.
    .orderBy(sql`case when ${netsuiteSyncOutbox.operation} = ${OPERATIONS.VERIFY} then 0 else 1 end`, asc(netsuiteSyncOutbox.createdAt));

  if (["APPROVED", "REJECTED", "NETSUITE_ERROR"].includes(loc.status)) {
    await transitionLocation(db, { locationId: loc.id, to: "SYNCING", actor, reason: "sending decision to NetSuite" });
  } else if (loc.status !== "SYNCING") {
    // Superseded (e.g. reprocessed and re-decided) or already finished: nothing to send.
    return "NOTHING_TO_DO";
  }

  const verify = pending.find((r) => r.operation === OPERATIONS.VERIFY);
  if (verify) {
    // Pre-write re-read (PRD §39): never overwrite a decision made in NetSuite directly.
    const ours = (verify.payload as VerificationPayload).decision;
    const remote = await netsuite.getLocation(loc.externalId);
    const current = remote.existingVerificationStatus ?? null;
    if (current !== null && current !== ours && current !== (await lastSyncedDecision(db, loc.id, payload.reviewId))) {
      throw new IntegrationError(
        `NetSuite already shows "${current}" for ${loc.externalId}, recorded outside ALVIP. Not overwritten; check the record in NetSuite.`,
        "NETSUITE_VALIDATION",
      );
    }
  }

  for (const row of pending) {
    await db
      .update(netsuiteSyncOutbox)
      .set({ status: "IN_FLIGHT", attempts: sql`${netsuiteSyncOutbox.attempts} + 1`, lastAttemptAt: new Date() })
      .where(eq(netsuiteSyncOutbox.id, row.id));
    await recordAudit(db, {
      eventType: "NETSUITE_SYNC_ATTEMPTED",
      actor,
      entityType: "netsuite_sync_outbox",
      entityId: row.id,
      locationId: loc.id,
      data: { operation: row.operation, attempt: row.attempts + 1 },
    });
    const ack =
      row.operation === OPERATIONS.VERIFY
        ? await netsuite.updateVerification(loc.externalId, {
            ...(row.payload as VerificationPayload),
            decidedAt: new Date((row.payload as VerificationPayload).decidedAt),
            idempotencyKey: row.idempotencyKey,
          })
        : await netsuite.addVerificationNote(loc.externalId, { body: (row.payload as { body: string }).body, idempotencyKey: row.idempotencyKey });
    await db
      .update(netsuiteSyncOutbox)
      .set({ status: "SUCCEEDED", syncedAt: new Date(), remoteRef: ack.remoteRef ?? null, alreadyApplied: ack.alreadyApplied, lastError: null, lastErrorCategory: null })
      .where(eq(netsuiteSyncOutbox.id, row.id));
    await recordAudit(db, {
      eventType: "NETSUITE_SYNC_SUCCEEDED",
      actor,
      entityType: "netsuite_sync_outbox",
      entityId: row.id,
      locationId: loc.id,
      data: { operation: row.operation, remoteRef: ack.remoteRef ?? null, alreadyApplied: ack.alreadyApplied },
    });
  }

  await db.transaction(async (tx) => {
    await transitionLocation(tx, { locationId: loc.id, to: "SYNCED_TO_NETSUITE", actor, expectedFrom: ["SYNCING"], reason: "NetSuite updated" });
    await transitionLocation(tx, { locationId: loc.id, to: "COMPLETED", actor, expectedFrom: ["SYNCED_TO_NETSUITE"], reason: "decision recorded in NetSuite" });
    // Earlier sync failures for this location are resolved now.
    await tx
      .update(systemErrors)
      .set({ resolvedAt: new Date() })
      .where(and(eq(systemErrors.locationId, loc.id), eq(systemErrors.source, `job:${JOB_TYPES.NETSUITE_SYNC}`), isNull(systemErrors.resolvedAt)));
  });
  return "SYNCED";
}

export const netsuiteSyncHandler: JobHandler = {
  type: JOB_TYPES.NETSUITE_SYNC,

  async handle(job, ctx) {
    await syncDecision(ctx.db, ctx.integrations.netsuite, job.payload as unknown as NetSuiteSyncPayload, { type: "WORKER", id: ctx.workerId });
  },

  async onFailure(job, error, outcome, ctx) {
    const payload = job.payload as unknown as NetSuiteSyncPayload;
    const actor: Actor = { type: "WORKER", id: ctx.workerId };
    await ctx.db
      .update(netsuiteSyncOutbox)
      .set({ status: outcome === "RETRY" ? "FAILED" : "DEAD", lastError: error.message.slice(0, 2000), lastErrorCategory: error.category })
      .where(and(eq(netsuiteSyncOutbox.reviewId, payload.reviewId), ne(netsuiteSyncOutbox.status, "SUCCEEDED")));
    await recordAudit(ctx.db, {
      eventType: "NETSUITE_SYNC_FAILED",
      actor,
      entityType: "locations",
      entityId: payload.locationId,
      locationId: payload.locationId,
      data: { category: error.category, outcome, attempt: job.attempts, maxAttempts: job.maxAttempts, message: error.message.slice(0, 500) },
    });
    if (outcome === "DEAD") {
      const [loc] = await ctx.db.select({ status: locations.status }).from(locations).where(eq(locations.id, payload.locationId));
      if (loc?.status === "SYNCING") {
        await transitionLocation(ctx.db, { locationId: payload.locationId, to: "NETSUITE_ERROR", actor, reason: `${error.category}: ${error.message}` });
      }
    }
  },
};

/** Team lead action after fixing the cause (credentials, NetSuite record, outage). */
export async function retryNetSuiteSync(db: Db, queue: QueueProvider, actor: Actor & { type: "USER" }, locationId: string, opts: { maxAttempts: number }) {
  const [loc] = await db.select({ status: locations.status }).from(locations).where(eq(locations.id, locationId));
  if (!loc) throw new LocationNotFoundError(`Location ${locationId} not found`);
  if (loc.status !== "NETSUITE_ERROR") throw new StaleLocationStateError(["NETSUITE_ERROR"], loc.status);
  const [row] = await db
    .select({ reviewId: netsuiteSyncOutbox.reviewId })
    .from(netsuiteSyncOutbox)
    .where(and(eq(netsuiteSyncOutbox.locationId, locationId), ne(netsuiteSyncOutbox.status, "SUCCEEDED")))
    .orderBy(desc(netsuiteSyncOutbox.createdAt))
    .limit(1);
  if (!row?.reviewId) throw new StaleLocationStateError(["NETSUITE_ERROR"], loc.status);

  return db.transaction(async (tx) => {
    await tx
      .update(netsuiteSyncOutbox)
      .set({ status: "PENDING" })
      .where(and(eq(netsuiteSyncOutbox.reviewId, row.reviewId!), ne(netsuiteSyncOutbox.status, "SUCCEEDED")));
    const { jobId } = await queue.enqueue(
      {
        type: JOB_TYPES.NETSUITE_SYNC,
        payload: { locationId, reviewId: row.reviewId! } satisfies NetSuiteSyncPayload,
        idempotencyKey: `netsuite-sync:${row.reviewId}:retry:${randomUUID()}`,
        locationId,
        maxAttempts: opts.maxAttempts,
      },
      tx,
    );
    await recordAudit(tx, { eventType: "NETSUITE_SYNC_RETRY_REQUESTED", actor, entityType: "locations", entityId: locationId, locationId, data: { jobId, reviewId: row.reviewId } });
    return { jobId };
  });
}

export async function outboxForLocation(db: Db, locationId: string) {
  return db
    .select({
      id: netsuiteSyncOutbox.id,
      reviewId: netsuiteSyncOutbox.reviewId,
      operation: netsuiteSyncOutbox.operation,
      status: netsuiteSyncOutbox.status,
      attempts: netsuiteSyncOutbox.attempts,
      lastError: netsuiteSyncOutbox.lastError,
      lastErrorCategory: netsuiteSyncOutbox.lastErrorCategory,
      createdAt: netsuiteSyncOutbox.createdAt,
      lastAttemptAt: netsuiteSyncOutbox.lastAttemptAt,
      syncedAt: netsuiteSyncOutbox.syncedAt,
      remoteRef: netsuiteSyncOutbox.remoteRef,
      alreadyApplied: netsuiteSyncOutbox.alreadyApplied,
    })
    .from(netsuiteSyncOutbox)
    .where(eq(netsuiteSyncOutbox.locationId, locationId))
    .orderBy(desc(netsuiteSyncOutbox.createdAt), asc(netsuiteSyncOutbox.operation));
}
