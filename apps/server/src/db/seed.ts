import { randomBytes } from "node:crypto";
import { count } from "drizzle-orm";
import type { Role } from "@alvip/shared";
import { SYSTEM_ACTOR } from "../audit/audit";
import { syncConfigToDb } from "../config/configStore";
import { loadDotEnvFile, loadEnv } from "../config/env";
import { loadVerificationConfigFromDir } from "../config/verificationConfig";
import { createUser } from "../services/auth";
import { openDb } from "./client";
import { users } from "./schema";

loadDotEnvFile();
const env = loadEnv();
const handle = await openDb({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR });
try {
  await handle.migrate();
  const config = loadVerificationConfigFromDir(env.CONFIG_DIR);
  const summary = await syncConfigToDb(handle.db, config, SYSTEM_ACTOR);
  console.log("Config sync:", JSON.stringify(summary, null, 2));

  // Local development convenience only: create one user per role with random
  // passwords printed once. Never runs in production.
  const [{ n } = { n: 0 }] = await handle.db.select({ n: count() }).from(users);
  if (env.NODE_ENV !== "production" && n === 0) {
    const devUsers: { email: string; displayName: string; role: Role }[] = [
      { email: "admin@alvip.local", displayName: "Dev Admin", role: "ADMIN" },
      { email: "lead@alvip.local", displayName: "Dev Team Lead", role: "TEAM_LEAD" },
      { email: "reviewer@alvip.local", displayName: "Dev Reviewer", role: "REVIEWER" },
    ];
    console.log("\nDev users created (passwords shown once — store them now):");
    for (const u of devUsers) {
      const password = randomBytes(12).toString("base64url");
      await createUser(handle.db, { ...u, password }, null);
      console.log(`  ${u.role.padEnd(10)} ${u.email}  ${password}`);
    }
  }
} finally {
  await handle.close();
}
