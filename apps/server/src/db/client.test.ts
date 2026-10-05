import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { DatabaseInUseError, openDb } from "./client";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), "alvip-db-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("embedded database ownership", () => {
  it("reopens after an unclean exit (stale postmaster.pid, dead owner)", async () => {
    const dir = tempDir();
    const h = await openDb({ pgliteDataDir: dir });
    await h.migrate();
    await h.close();
    // Simulate a force-killed run: PGlite's lock file and an owner record for a dead PID.
    writeFileSync(path.join(dir, "postmaster.pid"), "-42\n");
    writeFileSync(path.join(dir, "alvip-owner.json"), JSON.stringify({ pid: 999_999_9 }));

    const again = await openDb({ pgliteDataDir: dir });
    const r = await again.db.execute(sql`select 1 as ok`);
    expect(r).toBeTruthy();
    await again.close();
    expect(existsSync(path.join(dir, "alvip-owner.json"))).toBe(false); // released on close
  });

  it("refuses to open while another live process owns it", async () => {
    const dir = tempDir();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    try {
      writeFileSync(path.join(dir, "alvip-owner.json"), JSON.stringify({ pid: child.pid }));
      await expect(openDb({ pgliteDataDir: dir })).rejects.toBeInstanceOf(DatabaseInUseError);
    } finally {
      child.kill();
    }
  });
});
