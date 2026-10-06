import type { Env } from "./config/env";
import type { Db } from "./db/client";
import { createIntegrations, type Integrations } from "./integrations";
import { PgQueue } from "./integrations/queue/PgQueue";
import type { QueueProvider } from "./integrations/queue/QueueProvider";
import type { JobHandler, Logger } from "./pipeline/jobHandler";
import { processLocationHandler } from "./pipeline/processLocation";
import { Worker, type PeriodicTask } from "./pipeline/worker";
import { ingestQueue } from "./services/ingest";
import { netsuiteSyncHandler, queueUnsyncedDecisions } from "./services/netsuiteSync";
import { purgeExpiredImages } from "./services/retention";

// Evaluation imports createWorker (it runs the pipeline in a sandbox), so its handler is
// added lazily to avoid an import cycle at module load.
export const JOB_HANDLERS: JobHandler[] = [processLocationHandler, netsuiteSyncHandler];
let evaluationHandler: JobHandler | null = null;
export function registerEvaluationHandler(h: JobHandler) {
  evaluationHandler = h;
}

export interface Runtime {
  queue: QueueProvider;
  integrations: Integrations;
}

export function createRuntime(env: Env, db: Db, overrides: Partial<Runtime> = {}): Runtime {
  return {
    queue: overrides.queue ?? new PgQueue(db),
    integrations: overrides.integrations ?? createIntegrations(env),
  };
}

export function createWorker(env: Env, db: Db, runtime: Runtime, log: Logger, opts: { pollNetSuite?: boolean; evaluation?: boolean } = {}): Worker {
  const periodic: PeriodicTask[] = [];

  if ((opts.pollNetSuite ?? true) && env.NETSUITE_POLL_INTERVAL_SEC > 0) {
    periodic.push({
      name: "netsuite-ingest",
      intervalMs: env.NETSUITE_POLL_INTERVAL_SEC * 1000,
      run: async () => {
        const summary = await ingestQueue({
          db,
          netsuite: runtime.integrations.netsuite,
          queue: runtime.queue,
          actor: { type: "SYSTEM", id: "netsuite-poller" },
        });
        if (summary.created > 0 || summary.fetchFailures > 0) log.info({ summary }, "netsuite ingest");
      },
    });
  }

  if (env.NETSUITE_SYNC_SWEEP_INTERVAL_SEC > 0) {
    periodic.push({
      name: "netsuite-sync-sweep",
      intervalMs: env.NETSUITE_SYNC_SWEEP_INTERVAL_SEC * 1000,
      run: async () => {
        const n = await queueUnsyncedDecisions(db, runtime.queue, { maxAttempts: env.NETSUITE_SYNC_MAX_ATTEMPTS });
        if (n > 0) log.info({ queued: n }, "queued decisions for NetSuite sync");
      },
    });
  }

  if (env.RETENTION_SWEEP_INTERVAL_SEC > 0) {
    periodic.push({
      name: "image-retention",
      intervalMs: env.RETENTION_SWEEP_INTERVAL_SEC * 1000,
      run: async () => {
        const r = await purgeExpiredImages(db, runtime.integrations.storage, {
          retentionDays: env.IMAGE_RETENTION_DAYS,
          actor: { type: "SYSTEM", id: "retention" },
        });
        if (r.purged > 0) log.info(r, "purged expired images");
      },
    });
  }

  const handlers = opts.evaluation === false || !evaluationHandler ? JOB_HANDLERS : [...JOB_HANDLERS, evaluationHandler];
  return new Worker({ db, env, queue: runtime.queue, integrations: runtime.integrations, handlers, log, periodic });
}
