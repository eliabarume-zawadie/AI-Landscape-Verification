import type { Lane, LocationStatus } from "@alvip/shared";
import { ERROR_STATUSES } from "@alvip/shared";

/**
 * Allowed location status transitions (PRD §34 + IMPLEMENTATION_PLAN C3).
 *
 * Notes on non-obvious edges:
 *  - In-progress states → QUEUED: crash recovery when a worker lease expires.
 *  - DOWNLOADING → HUMAN_REVIEW: automation level 0 (manual) skips AI analysis.
 *  - Error states → HUMAN_REVIEW: manual fallback so the queue can still clear when
 *    the AI provider is down (team lead action).
 *  - → QUEUED from review/error/completed states: reprocessing (PRD §43); creates a
 *    new processing run and never deletes previous results.
 *  - APPROVED/REJECTED/SYNCING/NETSUITE_ERROR cannot be reprocessed: a decision is
 *    waiting to sync and must land first so it is never orphaned.
 */
const TRANSITIONS: Record<LocationStatus, readonly LocationStatus[]> = {
  NEW: ["QUEUED", "INTEGRATION_ERROR"],
  QUEUED: ["DOWNLOADING", "INTEGRATION_ERROR"],
  DOWNLOADING: ["ANALYZING", "HUMAN_REVIEW", "QUEUED", "IMAGE_ERROR", "INTEGRATION_ERROR"],
  ANALYZING: ["EVIDENCE_BUILDING", "QUEUED", "AI_ERROR", "IMAGE_ERROR"],
  EVIDENCE_BUILDING: ["AI_REVIEW_READY", "QUEUED", "AI_ERROR"],
  AI_REVIEW_READY: ["HUMAN_REVIEW", "QUEUED"],
  HUMAN_REVIEW: ["APPROVED", "REJECTED", "ESCALATED", "QUEUED"],
  ESCALATED: ["HUMAN_REVIEW", "APPROVED", "REJECTED", "QUEUED"],
  APPROVED: ["SYNCING"],
  REJECTED: ["SYNCING"],
  SYNCING: ["SYNCED_TO_NETSUITE", "NETSUITE_ERROR"],
  NETSUITE_ERROR: ["SYNCING"],
  SYNCED_TO_NETSUITE: ["COMPLETED"],
  COMPLETED: ["QUEUED"],
  IMAGE_ERROR: ["QUEUED", "HUMAN_REVIEW"],
  AI_ERROR: ["QUEUED", "HUMAN_REVIEW"],
  INTEGRATION_ERROR: ["QUEUED", "HUMAN_REVIEW"],
};

export const IN_PROGRESS_STATUSES: readonly LocationStatus[] = [
  "DOWNLOADING",
  "ANALYZING",
  "EVIDENCE_BUILDING",
];

export class InvalidTransitionError extends Error {
  override name = "InvalidTransitionError";
  constructor(
    readonly from: LocationStatus,
    readonly to: LocationStatus,
  ) {
    super(`Invalid location status transition ${from} → ${to}`);
  }
}

export function canTransition(from: LocationStatus, to: LocationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: LocationStatus, to: LocationStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function allowedTransitions(from: LocationStatus): readonly LocationStatus[] {
  return TRANSITIONS[from];
}

export function isErrorStatus(status: LocationStatus): boolean {
  return (ERROR_STATUSES as readonly LocationStatus[]).includes(status);
}

export function canReprocess(status: LocationStatus): boolean {
  return canTransition(status, "QUEUED") && !IN_PROGRESS_STATUSES.includes(status) && status !== "NEW";
}

/** Exception Lane membership is driven by status; Fast vs Human Review is decided by the risk engine. */
export function laneForErrorStatus(status: LocationStatus): Lane | null {
  return isErrorStatus(status) ? "EXCEPTION" : null;
}
