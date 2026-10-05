import type { ErrorCategory } from "@alvip/shared";

/** Asynchronous job queue (PRD §47). Default implementation is Postgres-backed (plan C1). */
export interface QueueProvider {
  /** `created` is false when a job with the same idempotency key already exists. */
  enqueue(job: EnqueueRequest): Promise<{ jobId: string; created: boolean }>;
  /** Claim up to `limit` due jobs of the given types with a lease. */
  claim(workerId: string, types: readonly string[], limit: number, leaseMs: number): Promise<ClaimedJob[]>;
  complete(jobId: string, workerId: string): Promise<void>;
  /** Retries TRANSIENT/MODEL_ERROR with backoff; other categories go straight to DEAD. */
  fail(jobId: string, workerId: string, error: { message: string; category: ErrorCategory }): Promise<"RETRY" | "DEAD">;
  /** Re-queue jobs whose lease expired (worker crash recovery). */
  recoverExpiredLeases(): Promise<number>;
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
