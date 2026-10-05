import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export interface DbHandle {
  db: Db;
  kind: "postgres" | "pglite";
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export interface DbOptions {
  /** Postgres URL. When omitted, embedded PGlite is used (dev/test only). */
  databaseUrl?: string | undefined;
  /** PGlite data directory; "memory://" for an ephemeral in-memory database. */
  pgliteDataDir?: string;
}

/** Another live process is using the embedded database (PGlite is single-process). */
export class DatabaseInUseError extends Error {
  override name = "DatabaseInUseError";
  constructor(
    readonly dataDir: string,
    readonly pid: number,
  ) {
    super(`The local database ${dataDir} is in use by another ALVIP process (PID ${pid}). Stop it first.`);
  }
}

const OWNER_FILE = "alvip-owner.json";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check only
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours to signal
  }
}

/**
 * PGlite always writes postmaster.pid with a placeholder PID (-42), so it cannot tell a
 * crashed run from a live one, and refuses to open after any unclean exit (force-kill,
 * dev-watcher restart, closed terminal). We record the real owning PID next to the data:
 *  - owner alive (and not us) → refuse with a clear error (never two writers)
 *  - owner dead or unknown    → the lock is stale: remove it; Postgres runs normal crash recovery
 */
export function claimDataDir(dataDir: string): { release(): void; recoveredStaleLock: boolean } {
  const ownerPath = path.join(dataDir, OWNER_FILE);
  const pgLock = path.join(dataDir, "postmaster.pid");
  if (existsSync(ownerPath)) {
    try {
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid: number };
      if (owner.pid !== process.pid && isAlive(owner.pid)) throw new DatabaseInUseError(dataDir, owner.pid);
    } catch (err) {
      if (err instanceof DatabaseInUseError) throw err; // unreadable owner file = stale
    }
  }
  const recoveredStaleLock = existsSync(pgLock);
  if (recoveredStaleLock) rmSync(pgLock, { force: true });
  writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  const release = () => {
    try {
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid: number };
      if (owner.pid === process.pid) rmSync(ownerPath, { force: true });
    } catch {
      // already gone
    }
  };
  process.once("exit", release);
  return { release, recoveredStaleLock };
}

export async function openDb(opts: DbOptions): Promise<DbHandle> {
  if (opts.databaseUrl) {
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 10 });
    const db = drizzlePg(pool, { schema }) as unknown as Db;
    return {
      db,
      kind: "postgres",
      migrate: () => migratePg(drizzlePg(pool), { migrationsFolder: MIGRATIONS_DIR }),
      close: () => pool.end(),
    };
  }

  const dataDir = opts.pgliteDataDir ?? "memory://";
  let claim: ReturnType<typeof claimDataDir> | null = null;
  if (!dataDir.startsWith("memory://")) {
    mkdirSync(dataDir, { recursive: true });
    claim = claimDataDir(dataDir);
    if (claim.recoveredStaleLock) console.log(`Recovered a stale database lock in ${dataDir} (previous run did not shut down cleanly).`);
  }
  let client: PGlite;
  try {
    client = await PGlite.create(dataDir);
  } catch (err) {
    claim?.release();
    throw err;
  }
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  return {
    db,
    kind: "pglite",
    migrate: () => migratePglite(drizzlePglite(client), { migrationsFolder: MIGRATIONS_DIR }),
    close: async () => {
      await client.close();
      claim?.release();
    },
  };
}
