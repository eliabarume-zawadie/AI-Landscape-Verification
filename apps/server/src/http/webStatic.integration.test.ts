import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DbHandle } from "../db/client";
import { createRuntime } from "../runtime";
import { LoginThrottle } from "../services/auth";
import { createTestDb, testEnv } from "../test/helpers";
import { buildApp } from "./app";

let h: DbHandle;
let app: FastifyInstance;
let dist: string;

beforeAll(async () => {
  dist = mkdtempSync(path.join(tmpdir(), "alvip-web-"));
  mkdirSync(path.join(dist, "assets"));
  writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>ALVIP</title>");
  writeFileSync(path.join(dist, "assets", "app-123.js"), "console.log(1)");
  h = await createTestDb();
  const env = testEnv({ WEB_DIST_DIR: dist });
  app = await buildApp({ env, db: h.db, loginThrottle: new LoginThrottle(), ...createRuntime(env, h.db) });
});
afterAll(async () => {
  await app.close();
  await h.close();
  rmSync(dist, { recursive: true, force: true });
});

describe("serving the reviewer UI", () => {
  it("serves the app shell for client-side routes, with a CSP and no caching", async () => {
    const res = await app.inject({ url: "/review/some-id" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["content-security-policy"]).toMatch(/default-src 'self'/);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("caches fingerprinted assets and returns a real 404 for missing ones", async () => {
    const ok = await app.inject({ url: "/assets/app-123.js" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toMatch(/immutable/);
    const missing = await app.inject({ url: "/assets/gone.js" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).not.toMatch(/text\/html/);
  });

  it("never answers API routes with HTML", async () => {
    const res = await app.inject({ url: "/api/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "NOT_FOUND" });
  });
});
