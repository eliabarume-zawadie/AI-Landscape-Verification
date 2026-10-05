import type { ErrorCategory } from "@alvip/shared";
import type { Db } from "../../db/client";
import type { FailureOutcome } from "../../domain/retry";

/**
 * Asynchronous job queue (PRD §47). The implementation is Postgres-backed (plan C1),
 * which is why `enqueue` accepts a transaction handle: jobs are enqueued atomically with
 * the state change that requires them.
 */
export interface QueueProvider {
  /** `created` is false when a job with the same idempotency key already exists. */
  enqueue(job: EnqueueRequest, executor?: Db): Promise<{ jobId: string; created: boolean }>;
  /** Claim up to `limit` due jobs of the given types, oldest first within priority. */
  claim(workerId: string, types: readonly string[], limit: number, leaseMs: number): Promise<ClaimedJob[]>;
  /** Extend the lease of a long-running job. Throws LeaseLostError if the lease was lost. */
  heartbeat(jobId: string, workerId: string, leaseMs: number): Promise<void>;
  /** Throws LeaseLostError if this worker no longer holds the job. */
  complete(jobId: string, workerId: string): Promise<void>;
  /** Retries TRANSIENT/MODEL_ERROR with backoff; other categories go straight to DEAD. */
  fail(jobId: string, workerId: string, error: { message: string; category: ErrorCategory }): Promise<FailureOutcome>;
  /** Re-queue jobs whose lease expired (worker crash recovery); exhausted ones become DEAD. */
  recoverExpiredLeases(): Promise<{ requeued: number; dead: ClaimedJob[] }>;
}

export interface EnqueueRequest {
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
  locationId?: string;
}

export interface ClaimedJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  locationId: string | null;
}

export class LeaseLostError extends Error {
  override name = "LeaseLostError";
}
