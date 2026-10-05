import { loadActiveConfig } from "./config/configStore";
import { loadDotEnvFile, loadEnv } from "./config/env";
import { openDb } from "./db/client";
import { buildApp } from "./http/app";
import { LoginThrottle } from "./services/auth";

loadDotEnvFile();
const env = loadEnv();
const handle = await openDb({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR });
await handle.migrate();
// Fail fast if the database has no valid active configuration.
await loadActiveConfig(handle.db);

const app = await buildApp({ env, db: handle.db, loginThrottle: new LoginThrottle() });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: env.HOST, port: env.PORT });
app.log.info(
  {
    db: handle.kind,
    automationLevel: env.AUTOMATION_LEVEL,
    shadowMode: env.SHADOW_MODE,
    mocks: { netsuite: env.MOCK_NETSUITE, ai: env.MOCK_AI, images: env.MOCK_IMAGES },
  },
  "ALVIP API started",
);
