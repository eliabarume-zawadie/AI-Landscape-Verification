import type { ErrorCategory } from "@alvip/shared";

/**
 * PRD §78 retry policy.
 *   TRANSIENT, MODEL_ERROR        → retry with exponential backoff
 *   AUTHENTICATION                → stop and alert
 *   INVALID_IMAGE                 → exception
 *   NETSUITE_VALIDATION           → human/admin intervention
 *   CONFIGURATION, INTERNAL       → stop (retrying will not help)
 */
const RETRYABLE: ReadonlySet<ErrorCategory> = new Set(["TRANSIENT", "MODEL_ERROR"]);

export function isRetryable(category: ErrorCategory): boolean {
  return RETRYABLE.has(category);
}

export interface BackoffPolicy {
  baseMs: number;
  capMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 30_000, capMs: 30 * 60_000 };

/**
 * Delay before the next attempt, given the number of attempts already made (≥1).
 * `jitter` in [0,1) spreads retries so a recovering dependency isn't hit all at once;
 * the delay is in [half, full] of the exponential value.
 */
export function backoffDelayMs(attemptsMade: number, policy: BackoffPolicy = DEFAULT_BACKOFF, jitter = 0): number {
  const exp = Math.min(policy.capMs, policy.baseMs * 2 ** Math.max(0, attemptsMade - 1));
  return Math.round(exp / 2 + (exp / 2) * jitter);
}

export type FailureOutcome = "RETRY" | "DEAD";

export function decideFailureOutcome(category: ErrorCategory, attemptsMade: number, maxAttempts: number): FailureOutcome {
  return isRetryable(category) && attemptsMade < maxAttempts ? "RETRY" : "DEAD";
}
