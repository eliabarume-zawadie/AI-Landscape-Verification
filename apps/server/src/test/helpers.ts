import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_ACTOR } from "../audit/audit";
import { syncConfigToDb } from "../config/configStore";
import { loadEnv, type Env } from "../config/env";
import { loadVerificationConfigFromDir } from "../config/verificationConfig";
import { openDb, type DbHandle } from "../db/client";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const CONFIG_DIR = path.join(REPO_ROOT, "config");

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", COOKIE_SECURE: "false", ...overrides });
}

/** Fresh in-memory Postgres (PGlite) with migrations applied and config seeded. */
export async function createTestDb(opts: { seedConfig?: boolean } = {}): Promise<DbHandle> {
  const handle = await openDb({ pgliteDataDir: "memory://" });
  await handle.migrate();
  if (opts.seedConfig ?? true) {
    await syncConfigToDb(handle.db, loadVerificationConfigFromDir(CONFIG_DIR), SYSTEM_ACTOR);
  }
  return handle;
}
