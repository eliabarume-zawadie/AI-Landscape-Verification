import type { Env } from "./config/env";
import type { Db } from "./db/client";
import { createIntegrations, type Integrations } from "./integrations";
import { PgQueue } from "./integrations/queue/PgQueue";
import type { QueueProvider } from "./integrations/queue/QueueProvider";
import type { JobHandler, Logger } from "./pipeline/jobHandler";
import { processLocationHandler } from "./pipeline/processLocation";
import { Worker } from "./pipeline/worker";
import { ingestQueue } from "./services/ingest";

export const JOB_HANDLERS: JobHandler[] = [processLocationHandler];

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

export function createWorker(env: Env, db: Db, runtime: Runtime, log: Logger, opts: { pollNetSuite?: boolean } = {}): Worker {
  const pollEvery = env.NETSUITE_POLL_INTERVAL_SEC * 1000;
  return new Worker({
    db,
    env,
    queue: runtime.queue,
    integrations: runtime.integrations,
    handlers: JOB_HANDLERS,
    log,
    periodic:
      (opts.pollNetSuite ?? true) && pollEvery > 0
        ? [
            {
              name: "netsuite-ingest",
              intervalMs: pollEvery,
              run: async () => {
                const summary = await ingestQueue({
                  db,
                  netsuite: runtime.integrations.netsuite,
                  queue: runtime.queue,
                  actor: { type: "SYSTEM", id: "netsuite-poller" },
                });
                if (summary.created > 0 || summary.fetchFailures > 0) log.info({ summary }, "netsuite ingest");
              },
            },
          ]
        : [],
  });
}
