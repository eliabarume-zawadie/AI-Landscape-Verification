import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { LocationStatus, ReprocessReason } from "@alvip/shared";
import { recordAudit, type Actor } from "../audit/audit";
import type { Db } from "../db/client";
import { clientProfiles, locations } from "../db/schema";
import { canReprocess } from "../domain/locationState";
import type { QueueProvider } from "../integrations/queue/QueueProvider";
import { JOB_TYPES, type ProcessLocationPayload } from "../pipeline/jobTypes";
import { LocationNotFoundError, StaleLocationStateError, transitionLocation } from "./locationTransitions";

/**
 * Reprocess a location (PRD §43). Creates a new processing run when the job executes;
 * earlier runs, reviews, and audit history are untouched.
 */
export async function requestReprocess(
  db: Db,
  queue: QueueProvider,
  input: { locationId: string; reason: ReprocessReason; note?: string; userId: string; actor: Actor },
): Promise<{ jobId: string }> {
  return db.transaction(async (tx) => {
    const [loc] = await tx
      .select({ status: locations.status, currentRunId: locations.currentRunId, clientId: locations.clientId })
      .from(locations)
      .where(eq(locations.id, input.locationId))
      .for("update");
    if (!loc) throw new LocationNotFoundError(`Location ${input.locationId} not found`);
    if (!canReprocess(loc.status)) {
      throw new StaleLocationStateError(["AI_REVIEW_READY", "HUMAN_REVIEW", "ESCALATED", "COMPLETED", "IMAGE_ERROR", "AI_ERROR", "INTEGRATION_ERROR"], loc.status);
    }

    await recordAudit(tx, {
      eventType: "REPROCESS_REQUESTED",
      actor: input.actor,
      entityType: "locations",
      entityId: input.locationId,
      locationId: input.locationId,
      data: {
        reason: input.reason,
        note: input.note ?? null,
        fromStatus: loc.status,
        previousRunId: loc.currentRunId,
      },
    });
    await transitionLocation(tx, {
      locationId: input.locationId,
      to: "QUEUED",
      actor: input.actor,
      reason: `reprocess: ${input.reason}`,
    });
    // The previous run's risk/recommendation no longer describe the location.
    await tx.update(locations).set({ riskLevel: null, aiRecommendation: null }).where(eq(locations.id, input.locationId));

    const [profile] = await tx
      .select({ profile: clientProfiles.profile })
      .from(clientProfiles)
      .where(and(eq(clientProfiles.clientId, loc.clientId), eq(clientProfiles.isActive, true)));
    const priority = Number((profile?.profile as { priority?: number } | undefined)?.priority ?? 0);

    const payload: ProcessLocationPayload = {
      locationId: input.locationId,
      reason: `REPROCESS:${input.reason}`,
      requestedBy: input.userId,
      ...(input.note ? { note: input.note } : {}),
    };
    const { jobId } = await queue.enqueue(
      {
        type: JOB_TYPES.PROCESS_LOCATION,
        payload: { ...payload },
        idempotencyKey: `process:${input.locationId}:reprocess:${randomUUID()}`,
        priority,
        locationId: input.locationId,
      },
      tx,
    );
    return { jobId };
  });
}

const MANUAL_FALLBACK_FROM: readonly LocationStatus[] = ["IMAGE_ERROR", "AI_ERROR", "INTEGRATION_ERROR"];

/**
 * Exception Lane fallback: send a location in an error state to manual human review
 * (e.g. AI provider outage) so the daily queue can still clear.
 */
export async function routeToManualReview(
  db: Db,
  input: { locationId: string; note?: string; actor: Actor },
): Promise<void> {
  const [loc] = await db.select({ status: locations.status }).from(locations).where(eq(locations.id, input.locationId));
  if (!loc) throw new LocationNotFoundError(`Location ${input.locationId} not found`);
  // NETSUITE_ERROR is excluded: it holds a decision waiting to sync, not unanalysed work.
  if (!MANUAL_FALLBACK_FROM.includes(loc.status)) {
    throw new StaleLocationStateError(MANUAL_FALLBACK_FROM, loc.status);
  }
  await transitionLocation(db, {
    locationId: input.locationId,
    to: "HUMAN_REVIEW",
    actor: input.actor,
    expectedFrom: [loc.status],
    lane: "HUMAN_REVIEW",
    reason: "MANUAL_FALLBACK",
    data: { note: input.note ?? null, aiAnalysisAvailable: false },
  });
}
