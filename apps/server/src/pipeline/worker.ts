import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Env } from "../config/env";
import type { Db } from "../db/client";
import type { Integrations } from "../integrations";
import type { ClaimedJob, QueueProvider } from "../integrations/queue/QueueProvider";
import { LeaseLostError } from "../integrations/queue/QueueProvider";
import { classifyError, recordSystemError, type ClassifiedError } from "../services/errors";
import type { JobContext, JobHandler, Logger } from "./jobHandler";

export interface WorkerDeps {
  db: Db;
  env: Env;
  queue: QueueProvider;
  integrations: Integrations;
  handlers: JobHandler[];
  log: Logger;
  workerId?: string;
  /** Periodic tasks run by the worker loop, e.g. polling the NetSuite queue. */
  periodic?: { name: string; intervalMs: number; run: () => Promise<unknown> }[];
}

/**
 * Claims jobs from the queue and runs them with bounded concurrency.
 * Safe to run as several processes against Postgres (SKIP LOCKED + leases).
 */
export class Worker {
  readonly workerId: string;
  private readonly handlers: Map<string, JobHandler>;
  private running = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private readonly periodicTimers: NodeJS.Timeout[] = [];
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: WorkerDeps) {
    this.workerId = deps.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.handlers = new Map(deps.handlers.map((h) => [h.type, h]));
  }

  private get leaseMs() {
    return this.deps.env.JOB_LEASE_SEC * 1000;
  }

  /** Recover expired leases, then claim and process one batch. Returns jobs processed. */
  async runOnce(): Promise<number> {
    await this.recoverLeases();
    const jobs = await this.deps.queue.claim(
      this.workerId,
      [...this.handlers.keys()],
      this.deps.env.WORKER_CONCURRENCY,
      this.leaseMs,
    );
    await Promise.all(jobs.map((job) => this.process(job)));
    return jobs.length;
  }

  /** Process until no due jobs remain (tests, demo scripts). */
  async drain(maxBatches = 1000): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const n = await this.runOnce();
      if (n === 0) break;
      total += n;
    }
    return total;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const task of this.deps.periodic ?? []) {
      const tick = () => {
        task.run().catch((err) => this.deps.log.error({ err, task: task.name }, "periodic task failed"));
      };
      tick();
      this.periodicTimers.push(setInterval(tick, task.intervalMs));
    }
    const loop = async () => {
      if (!this.running) return;
      let processed = 0;
      try {
        this.inFlight = this.runOnce();
        processed = (await this.inFlight) as number;
      } catch (err) {
        this.deps.log.error({ err }, "worker loop error");
      }
      if (this.running) {
        this.loopTimer = setTimeout(loop, processed > 0 ? 0 : this.deps.env.WORKER_POLL_INTERVAL_MS);
      }
    };
    void loop();
    this.deps.log.info({ workerId: this.workerId }, "worker started");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    for (const t of this.periodicTimers) clearInterval(t);
    await this.inFlight.catch(() => undefined);
    this.deps.log.info({ workerId: this.workerId }, "worker stopped");
  }

  private context(job: ClaimedJob): JobContext {
    return {
      db: this.deps.db,
      env: this.deps.env,
      queue: this.deps.queue,
      integrations: this.deps.integrations,
      workerId: this.workerId,
      log: this.deps.log,
      heartbeat: () => this.deps.queue.heartbeat(job.id, this.workerId, this.leaseMs),
    };
  }

  private async process(job: ClaimedJob): Promise<void> {
    const handler = this.handlers.get(job.type)!;
    const ctx = this.context(job);
    const started = Date.now();
    try {
      await handler.handle(job, ctx);
      await this.deps.queue.complete(job.id, this.workerId);
      this.deps.log.info({ jobId: job.id, type: job.type, ms: Date.now() - started }, "job completed");
    } catch (err) {
      if (err instanceof LeaseLostError) {
        // Another worker owns the job now; it will handle completion/failure.
        this.deps.log.warn({ jobId: job.id }, "lease lost");
        return;
      }
      const classified = classifyError(err);
      await this.handleFailure(job, classified, ctx, err);
    }
  }

  private async handleFailure(job: ClaimedJob, classified: ClassifiedError, ctx: JobContext, err?: unknown) {
    const outcome = await this.deps.queue
      .fail(job.id, this.workerId, { message: classified.message, category: classified.category })
      .catch((e) => {
        if (e instanceof LeaseLostError) return null;
        throw e;
      });
    if (outcome === null) return;

    this.deps.log.warn(
      { jobId: job.id, type: job.type, attempt: job.attempts, outcome, category: classified.category, err },
      "job failed",
    );
    await recordSystemError(this.deps.db, {
      category: classified.category,
      source: `job:${job.type}`,
      message: classified.message,
      details: { attempt: job.attempts, maxAttempts: job.maxAttempts, outcome },
      locationId: job.locationId,
      jobId: job.id,
      actor: { type: "WORKER", id: this.workerId },
    });
    await this.handlers.get(job.type)?.onFailure?.(job, classified, outcome, ctx);
  }

  private async recoverLeases(): Promise<void> {
    const { requeued, dead } = await this.deps.queue.recoverExpiredLeases();
    if (requeued > 0) this.deps.log.warn({ requeued }, "requeued jobs with expired leases");
    for (const job of dead) {
      const classified: ClassifiedError = {
        category: "TRANSIENT",
        errorStatus: "INTEGRATION_ERROR",
        message: "Job lease expired after the final attempt (worker crash or timeout)",
      };
      await recordSystemError(this.deps.db, {
        category: classified.category,
        source: `job:${job.type}`,
        message: classified.message,
        locationId: job.locationId,
        jobId: job.id,
        actor: { type: "WORKER", id: this.workerId },
      });
      await this.handlers.get(job.type)?.onFailure?.(job, classified, "DEAD", this.context(job));
    }
  }
}
