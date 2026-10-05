import { eq, sql } from "drizzle-orm";
import type { Lane, LocationStatus } from "@alvip/shared";
import { recordAudit, type Actor } from "../audit/audit";
import type { Db } from "../db/client";
import { locations } from "../db/schema";
import { assertTransition, canTransition, isErrorStatus } from "../domain/locationState";

export class LocationNotFoundError extends Error {
  override name = "LocationNotFoundError";
}

export class StaleLocationStateError extends Error {
  override name = "StaleLocationStateError";
  constructor(
    readonly expected: readonly LocationStatus[],
    readonly actual: LocationStatus,
  ) {
    super(`Location is ${actual}, expected one of ${expected.join(", ")}`);
  }
}

export interface TransitionInput {
  locationId: string;
  to: LocationStatus;
  actor: Actor;
  /** Fail if the current status is not one of these (optimistic guard). */
  expectedFrom?: readonly LocationStatus[];
  /** Overrides the default lane for the target status. */
  lane?: Lane | null;
  reason?: string;
  runId?: string;
  data?: Record<string, unknown>;
}

/** Default lane by status. FAST vs HUMAN_REVIEW is refined by the risk engine (Phase 8). */
export function defaultLaneFor(status: LocationStatus): Lane | null {
  if (isErrorStatus(status)) return "EXCEPTION";
  if (status === "HUMAN_REVIEW" || status === "ESCALATED" || status === "AI_REVIEW_READY") return "HUMAN_REVIEW";
  return null;
}

/**
 * Move a location to a new status inside a transaction: lock the row, validate against
 * the state machine, update status/lane, and write a LOCATION_STATUS_CHANGED audit event.
 */
export async function transitionLocation(db: Db, input: TransitionInput): Promise<{ from: LocationStatus; to: LocationStatus }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ status: locations.status })
      .from(locations)
      .where(eq(locations.id, input.locationId))
      .for("update");
    if (!row) throw new LocationNotFoundError(`Location ${input.locationId} not found`);
    if (input.expectedFrom && !input.expectedFrom.includes(row.status)) {
      throw new StaleLocationStateError(input.expectedFrom, row.status);
    }
    assertTransition(row.status, input.to);

    await tx
      .update(locations)
      .set({
        status: input.to,
        lane: input.lane !== undefined ? input.lane : defaultLaneFor(input.to),
        statusChangedAt: sql`now()`,
      })
      .where(eq(locations.id, input.locationId));

    await recordAudit(tx, {
      eventType: "LOCATION_STATUS_CHANGED",
      actor: input.actor,
      entityType: "locations",
      entityId: input.locationId,
      locationId: input.locationId,
      ...(input.runId ? { runId: input.runId } : {}),
      data: { from: row.status, to: input.to, ...(input.reason ? { reason: input.reason } : {}), ...input.data },
    });
    return { from: row.status, to: input.to };
  });
}

/**
 * Pick the most specific error status reachable from `from`, falling back to
 * INTEGRATION_ERROR (reachable from every pre-review state).
 */
export function reachableErrorStatus(from: LocationStatus, preferred: LocationStatus): LocationStatus | null {
  if (canTransition(from, preferred)) return preferred;
  if (canTransition(from, "INTEGRATION_ERROR")) return "INTEGRATION_ERROR";
  return null;
}
