import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, count, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { evaluationResults, goldenExamples, locations, netsuiteSyncOutbox } from "../../db/schema";
import { buildApp } from "../../http/app";
import { SESSION_COOKIE } from "../../http/authPlugin";
import { createUser, LoginThrottle } from "../../services/auth";
import { importGoldenFolder } from "../../services/goldenImport";
import { createHarness, scenario, type Harness } from "../../test/harness";

let t: Harness;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const PW = "a-long-test-password";
const as = (who: string) => ({ cookie: cookies[who]! });
const loc = async (externalId: string) => (await t.h.db.select().from(locations).where(eq(locations.externalId, externalId)))[0]!;
const post = (who: string, url: string, payload?: unknown) => app.inject({ method: "POST", url, headers: as(who), ...(payload !== undefined ? { payload: payload as object } : {}) });
const dbError = (p: Promise<unknown>) => p.then(
  () => "no error",
  (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
);
const tmp: string[] = [];

beforeAll(async () => {
  t = await createHarness({
    scenarios: ["NS-DEMO-001", "NS-DEMO-002", "NS-DEMO-003", "NS-DEMO-004", "NS-DEMO-005", "NS-DEMO-006", "NS-DEMO-007", "NS-DEMO-009", "NS-DEMO-010", "NS-DEMO-011"].map(scenario),
  });
  app = await buildApp({ env: t.env, db: t.h.db, loginThrottle: new LoginThrottle(), ...t.runtime });
  for (const [who, role] of [["reviewer", "REVIEWER"], ["lead", "TEAM_LEAD"], ["lead2", "TEAM_LEAD"], ["admin", "ADMIN"]] as const) {
    await createUser(t.h.db, { email: `${who}@test.local`, displayName: who, role, password: PW }, null);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@test.local`, password: PW } });
    cookies[who] = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
  }
  await t.ingest();
  await t.worker.drain();
  await post("reviewer", `/api/locations/${(await loc("NS-DEMO-004")).id}/review`, { decision: "REJECT" });
  await t.worker.drain();
});
afterAll(async () => {
  await app.close();
  await t.close();
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe("golden examples (PRD §55)", () => {
  let id = "";

  it("a team lead turns a decided location into a draft example: photos copied, truth prefilled, tags suggested", async () => {
    expect((await post("reviewer", `/api/golden/from-location/${(await loc("NS-DEMO-004")).id}`, {})).statusCode).toBe(403);
    expect((await post("lead", `/api/golden/from-location/${(await loc("NS-DEMO-001")).id}`, {})).statusCode).toBe(409); // not decided
    const res = await post("lead", `/api/golden/from-location/${(await loc("NS-DEMO-004")).id}`, {});
    expect(res.statusCode).toBe(201);
    id = res.json().id;
    const ex = (await app.inject({ url: `/api/golden/${id}`, headers: as("lead") })).json();
    expect(ex).toMatchObject({ status: "DRAFT", source: "FROM_LOCATION", services: ["mowing"], expected: { mowing: "REJECT" }, reviewerDecision: "REJECT", createdByName: "lead" });
    expect(ex.tags).toEqual(expect.arrayContaining(["CONTRADICTION", "BEFORE_AFTER"]));
    expect(ex.images).toHaveLength(5);
    const img = await app.inject({ url: `/api/golden/images/${ex.images[0].id}/content`, headers: as("lead") });
    expect(img.headers["content-type"]).toBe("image/jpeg");
  });

  it("drafts can be edited; the creator can't approve their own label (another lead must)", async () => {
    expect((await app.inject({ method: "PATCH", url: `/api/golden/${id}`, headers: as("lead"), payload: { expected: { edging: "APPROVE" } } })).statusCode).toBe(422);
    expect((await app.inject({ method: "PATCH", url: `/api/golden/${id}`, headers: as("lead"), payload: { tags: ["CONTRADICTION"], notes: "Uncut strip at the back." } })).statusCode).toBe(200);
    expect((await post("lead", `/api/golden/${id}/approve`)).statusCode).toBe(403);
    expect((await post("lead2", `/api/golden/${id}/approve`)).statusCode).toBe(200);
    expect((await post("lead2", `/api/golden/${id}/approve`)).statusCode).toBe(409);
  });

  it("an approved example is frozen, in the API and in the database", async () => {
    expect((await app.inject({ method: "PATCH", url: `/api/golden/${id}`, headers: as("lead"), payload: { notes: "x" } })).statusCode).toBe(409);
    expect(await dbError(t.h.db.execute(sql`update golden_examples set expected = '{"mowing":"APPROVE"}' where id = ${id}`))).toMatch(/frozen/);
    expect(await dbError(t.h.db.execute(sql`delete from golden_examples where id = ${id}`))).toMatch(/cannot be deleted/);
    expect(await dbError(t.h.db.execute(sql`update golden_examples set status = 'DRAFT' where id = ${id}`))).toMatch(/not allowed/);
    expect(await dbError(t.h.db.execute(sql`delete from golden_example_images`))).toMatch(/append-only/);
  });

  it("demo examples are seeded once by an admin, approved and marked as demo", async () => {
    expect((await post("lead", "/api/golden/demo")).statusCode).toBe(403);
    const first = (await post("admin", "/api/golden/demo")).json();
    expect(first.created).toBe(10);
    expect((await post("admin", "/api/golden/demo")).json().created).toBe(0);
    const list = (await app.inject({ url: "/api/golden?status=APPROVED", headers: as("lead") })).json().examples;
    expect(list.filter((e: { source: string }) => e.source === "DEMO")).toHaveLength(10);
  });

  it("imports labelled historical examples from a folder as drafts, all or nothing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "alvip-golden-"));
    tmp.push(dir);
    writeFileSync(path.join(dir, "before.jpg"), await sharp({ create: { width: 64, height: 48, channels: 3, background: "#557a3c" } }).jpeg().toBuffer());
    const manifest = (examples: unknown[]) => writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ examples }));
    manifest([{ title: "Bad", client: "NOPE", expected: { teleport: "APPROVE" }, images: [{ file: "missing.jpg" }, { file: "../outside.jpg" }] }]);
    const bad = await importGoldenFolder(t.h.db, t.storage, { type: "SYSTEM", id: "test" }, dir);
    expect(bad.imported).toBe(0);
    expect(bad.errors.join("\n")).toMatch(/unknown client "NOPE"[\s\S]*unknown service "teleport"[\s\S]*not found[\s\S]*outside the import folder/);
    manifest([{ title: "2025-06 Elm St", client: "DEMO_CLIENT_A", expected: { mowing: "APPROVE" }, tags: ["MISSING_AFTER"], reviewerDecision: "APPROVE", images: [{ file: "before.jpg", capturedAt: "2025-06-02T09:00:00Z" }] }]);
    expect(await importGoldenFolder(t.h.db, t.storage, { type: "SYSTEM", id: "test" }, dir)).toEqual({ imported: 1, errors: [] });
    const [ex] = await t.h.db.select().from(goldenExamples).where(eq(goldenExamples.title, "2025-06 Elm St"));
    expect(ex).toMatchObject({ status: "DRAFT", source: "IMPORT", createdBy: null });
  });
});

describe("evaluation runs (PRD §56)", () => {
  it("only admins may trial another model; nothing runs without approved examples in scope", async () => {
    expect((await post("lead", "/api/evaluations", { visionModel: "some-model" })).statusCode).toBe(403);
    // Only one non-demo example is approved; with a client filter that excludes it there is nothing to run.
    const other = (await t.h.db.execute(sql`select id from clients where code = 'DEMO_CLIENT_B'`)) as unknown as { rows: { id: string }[] };
    expect((await post("lead", "/api/evaluations", { clientId: other.rows[0]!.id })).statusCode).toBe(422);
  });

  it("runs the production pipeline in a sandbox, scores every example, and leaves live data untouched", async () => {
    const before = {
      locations: (await t.h.db.select({ n: count() }).from(locations))[0]!.n,
      outbox: (await t.h.db.select({ n: count() }).from(netsuiteSyncOutbox))[0]!.n,
      writes: t.netsuite.verificationWrites.size,
    };
    const res = await post("lead", "/api/evaluations", { label: "baseline", includeDemo: true });
    expect(res.statusCode).toBe(202);
    expect((await post("lead", "/api/evaluations", { includeDemo: true })).statusCode).toBe(409); // one at a time
    await t.worker.drain();

    const { run, results } = (await app.inject({ url: `/api/evaluations/${res.json().id}`, headers: as("lead") })).json();
    expect(run).toMatchObject({ status: "SUCCEEDED", exampleCount: 11, label: "baseline" });
    expect(run.versions).toMatchObject({ visionProvider: "mock", serviceRuleVersion: expect.any(String), thresholdsVersion: expect.any(String) });
    const s = run.summary;
    expect(s.examples).toBe(11);
    expect(s.demoExamples).toBe(10);
    expect(s.overall.samples).toBe(results.filter((r: { serviceCode: string | null }) => r.serviceCode !== null).length);
    expect(s.location.samples).toBe(11);
    expect(s.overall.errors).toBe(0);
    // The mock AI never approves what the truth rejects in these cases.
    expect(s.overall.falseApprovals).toBe(0);
    expect(s.overall.falseApprovalRate.ci95.high).toBeGreaterThan(0); // honest interval, not "0% exactly"
    expect(s.overall.smallSample).toBe(true);
    const outcome = (title: RegExp, svc: string) => results.find((r: { title: string; serviceCode: string }) => title.test(r.title) && r.serviceCode === svc)?.outcome;
    expect(outcome(/NS-DEMO-004\)$/, "mowing")).toBe("CORRECT"); // contradiction caught
    expect(outcome(/NS-DEMO-003\)$/, "weed_removal")).toBe("DEFERRED"); // "weeds reduced" is not proof
    expect(outcome(/NS-DEMO-011\)$/, "landscape_fertilization")).not.toBe("FALSE_APPROVAL"); // healthy grass ≠ fertilization
    expect(outcome(/NS-DEMO-001\)$/, "mowing")).toBe("CORRECT");
    expect(s.missingCoverage).not.toContain("CONTRADICTION");
    expect(Object.keys(s.byService)).toContain("mowing");

    // Isolation: no live locations, NetSuite writes or outbox rows were created.
    expect((await t.h.db.select({ n: count() }).from(locations))[0]!.n).toBe(before.locations);
    expect((await t.h.db.select({ n: count() }).from(netsuiteSyncOutbox))[0]!.n).toBe(before.outbox);
    expect(t.netsuite.verificationWrites.size).toBe(before.writes);
    // Results are append-only.
    expect(await dbError(t.h.db.update(evaluationResults).set({ outcome: "CORRECT" }).where(and(eq(evaluationResults.runId, run.id))))).toMatch(/append-only/);

    const list = (await app.inject({ url: "/api/evaluations", headers: as("lead") })).json().runs;
    expect(list[0]).toMatchObject({ id: run.id, status: "SUCCEEDED", demoExamples: 10 });
    expect(list[0].overall.samples).toBe(s.overall.samples);
  });
});
