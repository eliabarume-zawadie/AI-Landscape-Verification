import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { auditEvents, images, locations } from "../../db/schema";
import { buildApp } from "../../http/app";
import { SESSION_COOKIE } from "../../http/authPlugin";
import { createUser, LoginThrottle } from "../../services/auth";
import { createHarness, scenario, type Harness } from "../../test/harness";

let t: Harness;
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  t = await createHarness({ scenarios: [scenario("NS-DEMO-005"), scenario("NS-DEMO-006")] });
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

const locId = async (ext: string) => (await t.h.db.select().from(locations).where(eq(locations.externalId, ext)))[0]!.id;
const imageOf = async (ext: string, ref: string) =>
  (await t.h.db.select().from(images).where(and(eq(images.locationId, await locId(ext)), eq(images.externalRef, ref))))[0]!;

describe("GET /api/locations/:id/images", () => {
  it("lists images with quality and duplicate analysis for the current run", async () => {
    const res = await app.inject({ url: `/api/locations/${await locId("NS-DEMO-005")}/images`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toMatchObject({ total: 6, usable: 1, unusable: 5 });
    const corrupt = body.items.find((i: { externalRef: string }) => i.externalRef === "NS-DEMO-005-IMG004");
    expect(corrupt.analysis).toMatchObject({ usable: false, issues: ["CORRUPT"] });
    expect(corrupt.contentAvailable).toBe(true);
    expect(corrupt.storageKey).toBeUndefined();
    expect(corrupt.locator).toBeUndefined();
  });

  it("summarises duplicate clusters (demo case 6)", async () => {
    const body = (await app.inject({ url: `/api/locations/${await locId("NS-DEMO-006")}/images`, headers: { cookie } })).json();
    expect(body.summary).toMatchObject({ total: 26, uniqueClusters: 2, duplicates: 24 });
  });

  it("rejects a run ID from another location", async () => {
    const other = (await app.inject({ url: `/api/locations/${await locId("NS-DEMO-006")}`, headers: { cookie } })).json();
    const res = await app.inject({
      url: `/api/locations/${await locId("NS-DEMO-005")}/images?runId=${other.runs[0].id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/locations/:id/images/:imageId/content", () => {
  it("requires authentication", async () => {
    const img = await imageOf("NS-DEMO-005", "NS-DEMO-005-IMG006");
    const res = await app.inject({ url: `/api/locations/${img.locationId}/images/${img.id}/content` });
    expect(res.statusCode).toBe(401);
  });

  it("streams the full image privately and logs the view", async () => {
    const img = await imageOf("NS-DEMO-005", "NS-DEMO-005-IMG006");
    const res = await app.inject({ url: `/api/locations/${img.locationId}/images/${img.id}/content`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(res.rawPayload.length).toBe(img.bytes);

    const views = await t.h.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.eventType, "EVIDENCE_VIEWED"), eq(auditEvents.entityId, img.id)));
    expect(views).toHaveLength(1);
  });

  it("serves a small thumbnail without logging it as an evidence view", async () => {
    const img = await imageOf("NS-DEMO-006", "NS-DEMO-006-IMG002");
    const res = await app.inject({ url: `/api/locations/${img.locationId}/images/${img.id}/content?variant=thumb`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.width).toBe(360);
    const views = await t.h.db.select().from(auditEvents).where(and(eq(auditEvents.eventType, "EVIDENCE_VIEWED"), eq(auditEvents.entityId, img.id)));
    expect(views).toHaveLength(0);
  });

  it("returns 422 for an undecodable image instead of serving garbage", async () => {
    const img = await imageOf("NS-DEMO-005", "NS-DEMO-005-IMG004");
    const res = await app.inject({ url: `/api/locations/${img.locationId}/images/${img.id}/content?variant=thumb`, headers: { cookie } });
    expect(res.statusCode).toBe(422);
  });

  it("does not serve an image through another location's URL", async () => {
    const img = await imageOf("NS-DEMO-005", "NS-DEMO-005-IMG006");
    const res = await app.inject({ url: `/api/locations/${await locId("NS-DEMO-006")}/images/${img.id}/content`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it("returns 410 once purged under the retention policy", async () => {
    const img = await imageOf("NS-DEMO-006", "NS-DEMO-006-IMG003");
    await t.h.db.update(images).set({ purgedAt: new Date(), storageKey: null }).where(eq(images.id, img.id));
    const res = await app.inject({ url: `/api/locations/${img.locationId}/images/${img.id}/content`, headers: { cookie } });
    expect(res.statusCode).toBe(410);
  });
});
