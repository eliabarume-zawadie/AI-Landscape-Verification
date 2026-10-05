import { mkdirSync } from "node:fs";
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
  if (!dataDir.startsWith("memory://")) mkdirSync(dataDir, { recursive: true });
  const client = await PGlite.create(dataDir);
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  return {
    db,
    kind: "pglite",
    migrate: () => migratePglite(drizzlePglite(client), { migrationsFolder: MIGRATIONS_DIR }),
    close: () => client.close(),
  };
}
