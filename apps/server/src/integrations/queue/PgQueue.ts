import { and, asc, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { ErrorCategory } from "@alvip/shared";
import type { Db } from "../../db/client";
import { verificationJobs } from "../../db/schema";
import { backoffDelayMs, decideFailureOutcome, DEFAULT_BACKOFF, type BackoffPolicy, type FailureOutcome } from "../../domain/retry";
import { LeaseLostError, type ClaimedJob, type EnqueueRequest, type QueueProvider } from "./QueueProvider";

const returningCols = {
  id: verificationJobs.id,
  type: verificationJobs.type,
  payload: verificationJobs.payload,
  attempts: verificationJobs.attempts,
  maxAttempts: verificationJobs.maxAttempts,
  locationId: verificationJobs.locationId,
};

/** All times use the database clock (`now()`) so multiple workers agree on lease expiry. */
const msFromNow = (ms: number) => sql`now() + (${ms} * interval '1 millisecond')`;

export class PgQueue implements QueueProvider {
  constructor(
    private readonly db: Db,
    private readonly backoff: BackoffPolicy = DEFAULT_BACKOFF,
    private readonly random: () => number = Math.random,
  ) {}

  async enqueue(job: EnqueueRequest, executor: Db = this.db) {
    const [row] = await executor
      .insert(verificationJobs)
      .values({
        type: job.type,
        payload: job.payload,
        idempotencyKey: job.idempotencyKey,
        priority: job.priority ?? 0,
        runAt: job.runAt ?? new Date(),
        maxAttempts: job.maxAttempts ?? 5,
        locationId: job.locationId ?? null,
      })
      .onConflictDoNothing({ target: verificationJobs.idempotencyKey })
      .returning({ id: verificationJobs.id });
    if (row) return { jobId: row.id, created: true };

    const [existing] = await executor
      .select({ id: verificationJobs.id })
      .from(verificationJobs)
      .where(eq(verificationJobs.idempotencyKey, job.idempotencyKey));
    return { jobId: existing!.id, created: false };
  }

  async claim(workerId: string, types: readonly string[], limit: number, leaseMs: number): Promise<ClaimedJob[]> {
    if (types.length === 0 || limit <= 0) return [];
    const due = this.db
      .select({ id: verificationJobs.id })
      .from(verificationJobs)
      .where(
        and(
          eq(verificationJobs.status, "PENDING"),
          lte(verificationJobs.runAt, sql`now()`),
          inArray(verificationJobs.type, [...types]),
        ),
      )
      // Default prioritisation: priority, then oldest eligible work first (PRD §35).
      .orderBy(desc(verificationJobs.priority), asc(verificationJobs.runAt), asc(verificationJobs.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });

    const rows = await this.db
      .update(verificationJobs)
      .set({
        status: "RUNNING",
        lockedBy: workerId,
        lockedUntil: msFromNow(leaseMs),
        attempts: sql`${verificationJobs.attempts} + 1`,
      })
      .where(inArray(verificationJobs.id, due))
      .returning({ ...returningCols, priority: verificationJobs.priority, runAt: verificationJobs.runAt });
    // UPDATE ... RETURNING does not preserve the subquery's ORDER BY; restore it.
    rows.sort((a, b) => b.priority - a.priority || a.runAt.getTime() - b.runAt.getTime());
    return rows.map(({ priority: _p, runAt: _r, ...job }) => toClaimed(job));
  }

  async heartbeat(jobId: string, workerId: string, leaseMs: number) {
    const rows = await this.db
      .update(verificationJobs)
      .set({ lockedUntil: msFromNow(leaseMs) })
      .where(this.heldBy(jobId, workerId))
      .returning({ id: verificationJobs.id });
    if (rows.length === 0) throw new LeaseLostError(`Lease lost for job ${jobId}`);
  }

  async complete(jobId: string, workerId: string) {
    const rows = await this.db
      .update(verificationJobs)
      .set({ status: "SUCCEEDED", lockedBy: null, lockedUntil: null, completedAt: sql`now()` })
      .where(this.heldBy(jobId, workerId))
      .returning({ id: verificationJobs.id });
    if (rows.length === 0) throw new LeaseLostError(`Lease lost for job ${jobId}`);
  }

  async fail(jobId: string, workerId: string, error: { message: string; category: ErrorCategory }): Promise<FailureOutcome> {
    const [job] = await this.db
      .select({ attempts: verificationJobs.attempts, maxAttempts: verificationJobs.maxAttempts })
      .from(verificationJobs)
      .where(this.heldBy(jobId, workerId));
    if (!job) throw new LeaseLostError(`Lease lost for job ${jobId}`);

    const outcome = decideFailureOutcome(error.category, job.attempts, job.maxAttempts);
    const common = {
      lockedBy: null,
      lockedUntil: null,
      lastError: error.message.slice(0, 2000),
      lastErrorCategory: error.category,
    };
    await this.db
      .update(verificationJobs)
      .set(
        outcome === "RETRY"
          ? { ...common, status: "PENDING", runAt: msFromNow(backoffDelayMs(job.attempts, this.backoff, this.random())) }
          : { ...common, status: "DEAD", completedAt: sql`now()` },
      )
      .where(eq(verificationJobs.id, jobId));
    return outcome;
  }

  async recoverExpiredLeases() {
    const expired = and(eq(verificationJobs.status, "RUNNING"), lt(verificationJobs.lockedUntil, sql`now()`));
    const lostLease = { lockedBy: null, lockedUntil: null, lastError: "worker lease expired", lastErrorCategory: "TRANSIENT" as const };

    const dead = await this.db
      .update(verificationJobs)
      .set({ ...lostLease, status: "DEAD", completedAt: sql`now()` })
      .where(and(expired, sql`${verificationJobs.attempts} >= ${verificationJobs.maxAttempts}`))
      .returning(returningCols);
    const requeued = await this.db
      .update(verificationJobs)
      .set({ ...lostLease, status: "PENDING", runAt: sql`now()` })
      .where(expired)
      .returning({ id: verificationJobs.id });
    return { requeued: requeued.length, dead: dead.map(toClaimed) };
  }

  private heldBy(jobId: string, workerId: string) {
    return and(
      eq(verificationJobs.id, jobId),
      eq(verificationJobs.status, "RUNNING"),
      eq(verificationJobs.lockedBy, workerId),
    );
  }
}

function toClaimed(r: {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  locationId: string | null;
}): ClaimedJob {
  return { ...r, payload: (r.payload ?? {}) as Record<string, unknown> };
}
