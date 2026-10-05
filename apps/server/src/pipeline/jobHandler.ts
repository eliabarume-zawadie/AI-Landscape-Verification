import type { Env } from "../config/env";
import type { Db } from "../db/client";
import type { Integrations } from "../integrations";
import type { ClaimedJob, QueueProvider } from "../integrations/queue/QueueProvider";
import type { FailureOutcome } from "../domain/retry";
import type { ClassifiedError } from "../services/errors";

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface JobContext {
  db: Db;
  env: Env;
  queue: QueueProvider;
  integrations: Integrations;
  workerId: string;
  log: Logger;
  /** Extend the job lease during long work (e.g. 170-image locations). */
  heartbeat(): Promise<void>;
}

export interface JobHandler {
  readonly type: string;
  handle(job: ClaimedJob, ctx: JobContext): Promise<void>;
  /** Called after the queue recorded a failure (retry scheduled or dead-lettered). */
  onFailure?(job: ClaimedJob, error: ClassifiedError, outcome: FailureOutcome, ctx: JobContext): Promise<void>;
}
