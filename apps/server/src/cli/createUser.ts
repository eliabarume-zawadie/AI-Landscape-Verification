// Usage: ALVIP_NEW_PASSWORD=... npm run user:create -- <email> <role> "<display name>"
// The password is read from the environment so it never appears in shell history.
import { ROLES, type Role } from "@alvip/shared";
import { loadDotEnvFile, loadEnv } from "../config/env";
import { openDb } from "../db/client";
import { createUser } from "../services/auth";

const [email, role, displayName] = process.argv.slice(2);
const password = process.env.ALVIP_NEW_PASSWORD;

if (!email || !role || !displayName || !password || !(ROLES as readonly string[]).includes(role)) {
  console.error(
    `Usage: ALVIP_NEW_PASSWORD=... npm run user:create -- <email> <${ROLES.join("|")}> "<display name>"`,
  );
  process.exit(1);
}

loadDotEnvFile();
const env = loadEnv();
const handle = await openDb({ databaseUrl: env.DATABASE_URL, pgliteDataDir: env.PGLITE_DATA_DIR });
try {
  await handle.migrate();
  const user = await createUser(handle.db, { email, role: role as Role, displayName, password }, null);
  console.log(`Created ${user.role} ${user.email} (${user.id})`);
} finally {
  await handle.close();
}
