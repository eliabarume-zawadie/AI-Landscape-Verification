// Standalone worker process for production (run one or more alongside API instances
// started with WORKER_MODE=off). Requires PostgreSQL: PGlite cannot be shared between processes.
import pino from "pino";
import { loadActiveConfig } from "./config/configStore";
import { ConfigError, loadDotEnvFile, loadEnv } from "./config/env";
import { openDb } from "./db/client";
import { createRuntime, createWorker } from "./runtime";
import "./services/evaluation"; // registers the evaluation job handler

loadDotEnvFile();
const env = loadEnv();
if (!env.DATABASE_URL) {
  throw new ConfigError(
    "The standalone worker needs DATABASE_URL (PostgreSQL). With PGlite, run the API with WORKER_MODE=embedded instead.",
  );
}
const log = pino({ level: env.LOG_LEVEL });
const handle = await openDb({ databaseUrl: env.DATABASE_URL });
await handle.migrate();
await loadActiveConfig(handle.db);

const worker = createWorker(env, handle.db, createRuntime(env, handle.db), log);
const shutdown = async (signal: string) => {
  log.info({ signal }, "worker shutting down");
  await worker.stop();
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
worker.start();
