import { loadDotEnvFile, loadEnv } from "../config/env";
import { openDb } from "./client";

loadDotEnvFile();
const env = loadEnv();
const handle = await openDb({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR });
try {
  await handle.migrate();
  console.log(`Migrations applied (${handle.kind}).`);
} finally {
  await handle.close();
}
