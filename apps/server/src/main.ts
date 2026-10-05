import { loadActiveConfig } from "./config/configStore";
import { loadDotEnvFile, loadEnv } from "./config/env";
import { openDb } from "./db/client";
import { buildApp } from "./http/app";
import { createRuntime, createWorker } from "./runtime";
import { LoginThrottle } from "./services/auth";

loadDotEnvFile();
const env = loadEnv();
const handle = await openDb({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR });
await handle.migrate();
// Fail fast if the database has no valid active configuration.
await loadActiveConfig(handle.db);

const runtime = createRuntime(env, handle.db);
const app = await buildApp({ env, db: handle.db, loginThrottle: new LoginThrottle(), ...runtime });

// PGlite is single-process, so local development always runs the worker in-process.
const worker = env.WORKER_MODE === "embedded" ? createWorker(env, handle.db, runtime, app.log) : null;

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await worker?.stop();
  await app.close();
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: env.HOST, port: env.PORT });
worker?.start();
app.log.info(
  {
    db: handle.kind,
    worker: env.WORKER_MODE,
    automationLevel: env.AUTOMATION_LEVEL,
    shadowMode: env.SHADOW_MODE,
    mocks: { netsuite: env.MOCK_NETSUITE, ai: env.MOCK_AI, images: env.MOCK_IMAGES },
  },
  "ALVIP API started",
);
