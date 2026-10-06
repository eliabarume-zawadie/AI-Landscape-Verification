import { SYSTEM_ACTOR } from "./audit/audit";
import { loadActiveConfig, syncConfigToDb } from "./config/configStore";
import { ConfigError, loadDotEnvFile, loadEnv } from "./config/env";
import { loadVerificationConfigFromDir } from "./config/verificationConfig";
import { DatabaseInUseError, openDb } from "./db/client";
import { buildApp } from "./http/app";
import { createRuntime, createWorker } from "./runtime";
import "./services/evaluation"; // registers the evaluation job handler
import { LoginThrottle } from "./services/auth";

async function main() {
  loadDotEnvFile();
  const env = loadEnv();
  process.env.PGLITE_DATA_DIR ??= env.PGLITE_DATA_DIR; // for the error message below
  const handle = await openDb({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR });
  await handle.migrate();
  if (!env.DATABASE_URL) console.log(`Local data: ${env.PGLITE_DATA_DIR}`);
  if (env.NODE_ENV !== "production") {
    // Development: always run on the current config/ files. Idempotent; a changed file becomes
    // a new version (old versions are kept and the change is audited). Production config
    // changes stay deliberate (`npm run db:seed` as a release step).
    await syncConfigToDb(handle.db, loadVerificationConfigFromDir(env.CONFIG_DIR), SYSTEM_ACTOR);
  }
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
  const shown = env.HOST === "0.0.0.0" || env.HOST === "::" ? "localhost" : env.HOST;
  console.log(`\nALVIP is running: http://${shown}:${env.PORT}\n`);
}

main().catch((err) => {
  if (err instanceof DatabaseInUseError) {
    console.error(
      `\nALVIP cannot start: ${err.message}\n` +
        "Is `npm run dev` already running in another terminal? Use that one, or stop it with Ctrl+C.\n",
    );
  } else if (err instanceof ConfigError) {
    // Configuration problems get one clear sentence, not a stack trace.
    console.error(`\nALVIP cannot start: ${err.message}\n`);
  } else if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    console.error(`\nALVIP cannot start: port ${process.env.PORT ?? 3000} is already in use. Stop the other process or set PORT.\n`);
  } else if (String((err as Error)?.message).includes("PGlite failed to initialize")) {
    const dir = process.env.PGLITE_DATA_DIR ?? "the local database folder";
    console.error(
      `\nALVIP cannot start: the local database could not be opened (${dir}).\n` +
        "Its files may have been changed by a sync tool such as OneDrive, or damaged.\n" +
        "See docs/TROUBLESHOOTING.md → \"Local database cannot be opened\".\n",
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
