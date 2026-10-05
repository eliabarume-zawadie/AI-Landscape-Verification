import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { auditEvents, evidence, evidenceBundleItems, images, locations } from "../db/schema";
import { buildApp } from "../http/app";
import { SESSION_COOKIE } from "../http/authPlugin";
import { createUser, LoginThrottle } from "../services/auth";
import { createHarness, scenario, type Harness } from "../test/harness";

let t: Harness;
let app: FastifyInstance;
let cookie: string;

const loc = async (externalId: string) => (await t.h.db.select().from(locations).where(eq(locations.externalId, externalId)))[0]!;
const bundleOf = async (externalId: string) =>
  t.h.db
    .select({ ref: images.externalRef, rank: evidenceBundleItems.rank, reasons: evidenceBundleItems.reasons, services: evidenceBundleItems.services })
    .from(evidenceBundleItems)
    .innerJoin(images, eq(images.id, evidenceBundleItems.imageId))
    .where(eq(evidenceBundleItems.runId, (await loc(externalId)).currentRunId!))
    .orderBy(asc(evidenceBundleItems.rank));

beforeAll(async () => {
  t = await createHarness({ scenarios: ["NS-DEMO-001", "NS-DEMO-004", "NS-DEMO-006", "NS-DEMO-016"].map(scenario) });
  app = await buildApp({ env: t.env, db: t.h.db, loginThrottle: new LoginThrottle(), ...t.runtime });
  await createUser(t.h.db, { email: "r@test.local", displayName: "R", role: "REVIEWER", password: "a-long-test-password" }, null);
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "r@test.local", password: "a-long-test-password" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
  await t.ingest();
  await t.worker.drain();
});
afterAll(async () => {
  await app.close();
  await t.close();
});

describe("evidence bundle stage", () => {
  it("reduces the 170-image location to a small bundle (PRD §20)", async () => {
    const b = await bundleOf("NS-DEMO-016");
    expect(b.length).toBeGreaterThan(0);
    expect(b.length).toBeLessThanOrEqual(16);
    const [ev] = await t.h.db
      .select({ data: auditEvents.data })
      .from(auditEvents)
      .where(and(eq(auditEvents.runId, (await loc("NS-DEMO-016")).currentRunId!), eq(auditEvents.eventType, "EVIDENCE_BUNDLED")));
    expect(ev!.data).toMatchObject({ totalImages: 170, bundledImages: b.length });
  });

  it("demo case 4: the contradicting photo is in the bundle, ranked first", async () => {
    const b = await bundleOf("NS-DEMO-004");
    expect(b[0]!.reasons).toContain("CONTRADICTION");
    expect(b.map((e) => e.ref)).toContain("NS-DEMO-004-IMG005");
  });

  it("demo case 1: includes the establishing before/after pair for each service", async () => {
    const b = await bundleOf("NS-DEMO-001");
    const roles = b.flatMap((e) => (e.services as { service: string; role: string }[]).map((s) => `${s.service}:${s.role}`));
    for (const s of ["mowing", "edging", "shrub_pruning"]) {
      expect(roles).toContain(`${s}:BEFORE`);
      expect(roles).toContain(`${s}:AFTER`);
    }
  });

  it("demo case 6: duplicates never enter the bundle", async () => {
    const b = await bundleOf("NS-DEMO-006");
    expect(b.length).toBeLessThanOrEqual(2); // one before + one representative after
  });

  it("marks bundled evidence rows with their per-service order", async () => {
    const rows = await t.h.db
      .select()
      .from(evidence)
      .where(and(eq(evidence.runId, (await loc("NS-DEMO-001")).currentRunId!), eq(evidence.inBundle, true)));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.rank !== null && r.rank >= 1)).toBe(true);
  });
});

describe("APIs", () => {
  it("evidence endpoint returns the bundle and each service's bundled images", async () => {
    const body = (await app.inject({ url: `/api/locations/${(await loc("NS-DEMO-004")).id}/evidence`, headers: { cookie } })).json();
    expect(body.bundle.totalImages).toBe(5);
    expect(body.bundle.entries[0]).toMatchObject({ rank: 1, reasons: expect.arrayContaining(["CONTRADICTION"]) });
    const mowing = body.services.find((s: { service: string }) => s.service === "mowing");
    expect(mowing.bundle.map((i: { ref: string }) => i.ref)).toContain("NS-DEMO-004-IMG005");
  });

  it("image list can be ordered strongest evidence first, with bundle flags", async () => {
    const id = (await loc("NS-DEMO-016")).id;
    const body = (await app.inject({ url: `/api/locations/${id}/images?order=evidence`, headers: { cookie } })).json();
    const ranks = body.items.map((i: { analysis: { evidenceRank: number } }) => i.analysis.evidenceRank);
    expect(ranks).toEqual([...ranks].sort((a: number, b: number) => a - b));
    const firstNonBundled = body.items.findIndex((i: { inBundle: boolean }) => !i.inBundle);
    expect(body.items.slice(0, firstNonBundled).every((i: { inBundle: boolean }) => i.inBundle)).toBe(true);
    expect(body.summary.inBundle).toBe(firstNonBundled);
  });
});
