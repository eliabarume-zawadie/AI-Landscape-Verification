import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { auditEvents, feedback, images, locations } from "../../db/schema";
import { buildApp } from "../../http/app";
import { SESSION_COOKIE } from "../../http/authPlugin";
import { createUser, LoginThrottle } from "../../services/auth";
import { csvCell } from "../../services/feedbackReport";
import { feedbackTargets } from "../../services/review";
import { createHarness, scenario, type Harness } from "../../test/harness";

let t: Harness;
let app: FastifyInstance;
const cookies: Record<string, string> = {};
const PW = "a-long-test-password";

/** The database's own message (drizzle wraps it in "Failed query: ..."). */
const dbError = (p: Promise<unknown>) => p.then(
  () => "no error",
  (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
);

const loc = async (externalId: string) => (await t.h.db.select().from(locations).where(eq(locations.externalId, externalId)))[0]!;
const imagesOf = async (externalId: string) =>
  t.h.db.select({ id: images.id, ref: images.externalRef }).from(images).where(eq(images.locationId, (await loc(externalId)).id)).orderBy(images.externalRef);
const as = (who: string) => ({ cookie: cookies[who]! });
const review = async (who: string, externalId: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/locations/${(await loc(externalId)).id}/review`, headers: as(who), payload });
const feedbackFor = async (externalId: string) => t.h.db.select().from(feedback).where(eq(feedback.locationId, (await loc(externalId)).id));

beforeAll(async () => {
  t = await createHarness({ scenarios: ["NS-DEMO-001", "NS-DEMO-002", "NS-DEMO-003", "NS-DEMO-004", "NS-DEMO-009"].map(scenario) });
  app = await buildApp({ env: t.env, db: t.h.db, loginThrottle: new LoginThrottle(), ...t.runtime });
  for (const [who, role] of [["reviewer", "REVIEWER"], ["lead", "TEAM_LEAD"]] as const) {
    await createUser(t.h.db, { email: `${who}@test.local`, displayName: who, role, password: PW }, null);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@test.local`, password: PW } });
    cookies[who] = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
  }
  await t.ingest();
  await t.worker.drain();
});
afterAll(async () => {
  await app.close();
  await t.close();
});

describe("feedbackTargets", () => {
  it("one row per disagreeing service, times each flagged photo", () => {
    const c = [
      { service: null, message: "rec" },
      { service: "mowing", message: "m" },
      { service: "edging", message: "e" },
    ];
    expect(feedbackTargets(c, [])).toEqual([
      { service: "mowing", imageId: null },
      { service: "edging", imageId: null },
    ]);
    expect(feedbackTargets(c.slice(1, 2), ["i1", "i2"])).toEqual([
      { service: "mowing", imageId: "i1" },
      { service: "mowing", imageId: "i2" },
    ]);
  });
  it("falls back to one location-level row", () => {
    expect(feedbackTargets([{ service: null, message: "rec" }], [])).toEqual([{ service: null, imageId: null }]);
    expect(feedbackTargets([], [])).toEqual([{ service: null, imageId: null }]);
  });
});

describe("feedback capture on decisions (PRD §30)", () => {
  it("an override records the AI assessment, human decision, reason, photo, service and reviewer", async () => {
    const [img] = await imagesOf("NS-DEMO-009");
    const res = await review("reviewer", "NS-DEMO-009", {
      decision: "APPROVE",
      reasonCode: "AI_MISSED_EVIDENCE",
      reasonText: "North and south lawns are one contiguous lawn.",
      relevantImageIds: [img!.id],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ isOverride: true, feedbackRows: expect.any(Number) });

    const rows = await feedbackFor("NS-DEMO-009");
    expect(rows.length).toBe(res.json().feedbackRows);
    const mowing = rows.find((r) => r.serviceCode === "mowing")!;
    expect(mowing).toMatchObject({
      imageId: img!.id,
      aiStatus: "INSUFFICIENT_EVIDENCE",
      humanDecision: "APPROVE",
      isOverride: true,
      reasonCode: "AI_MISSED_EVIDENCE",
      reasonText: "North and south lawns are one contiguous lawn.",
      reviewId: res.json().reviewId,
    });
    expect(mowing.aiConfidence).not.toBeNull();
    expect(mowing.runId).not.toBeNull();
    // Every disagreeing service has a row; none for services the reviewer agreed with.
    expect(rows.every((r) => r.serviceCode !== null && r.aiStatus !== "SUPPORTED")).toBe(true);
  });

  it("feedback is append-only", async () => {
    expect(await dbError(t.h.db.execute(sql`update feedback set reason_text = 'changed'`))).toMatch(/append-only/);
    expect(await dbError(t.h.db.execute(sql`delete from feedback`))).toMatch(/append-only/);
  });

  it("a reason given while agreeing is kept as feedback, marked as not an override", async () => {
    const res = await review("reviewer", "NS-DEMO-003", { decision: "REJECT", reasonCode: "IMAGE_INSUFFICIENT" });
    expect(res.json()).toMatchObject({ status: "REJECTED", isOverride: false, feedbackRows: 1 });
    const [row] = await feedbackFor("NS-DEMO-003");
    expect(row).toMatchObject({ serviceCode: null, isOverride: false, humanDecision: "REJECT", reasonCode: "IMAGE_INSUFFICIENT" });
  });

  it("no reason, no feedback rows", async () => {
    const res = await review("reviewer", "NS-DEMO-002", { decision: "APPROVE" });
    expect(res.json()).toMatchObject({ isOverride: false, feedbackRows: 0 });
    expect(await feedbackFor("NS-DEMO-002")).toHaveLength(0);
  });

  it("flagged photos must belong to the location and need a reason", async () => {
    const [other] = await imagesOf("NS-DEMO-001");
    const [own] = await imagesOf("NS-DEMO-004");
    const foreign = await review("reviewer", "NS-DEMO-004", { decision: "REJECT", reasonCode: "CONTRADICTORY_EVIDENCE", relevantImageIds: [other!.id] });
    expect(foreign.statusCode).toBe(422);
    const noReason = await review("reviewer", "NS-DEMO-004", { decision: "REJECT", relevantImageIds: [own!.id] });
    expect(noReason.statusCode).toBe(422);
    expect(noReason.json().error).toBe("REASON_REQUIRED");
    expect((await loc("NS-DEMO-004")).status).toBe("HUMAN_REVIEW");
    expect(await feedbackFor("NS-DEMO-004")).toHaveLength(0);
  });

  it("review history includes the feedback rows", async () => {
    const res = await app.inject({ url: `/api/locations/${(await loc("NS-DEMO-009")).id}/reviews`, headers: as("reviewer") });
    const [r] = res.json().reviews;
    expect(r.feedback.length).toBeGreaterThan(0);
    expect(r.feedback[0]).toMatchObject({ serviceCode: "mowing", reasonCode: "AI_MISSED_EVIDENCE", imageRef: expect.any(String) });
  });
});

describe("GET /api/feedback (team leads)", () => {
  it("is for team leads only", async () => {
    expect((await app.inject({ url: "/api/feedback", headers: as("reviewer") })).statusCode).toBe(403);
  });

  it("lists feedback with names and a summary, filterable", async () => {
    const all = (await app.inject({ url: "/api/feedback", headers: as("lead") })).json();
    expect(all.summary.total).toBe(all.rows.length);
    expect(all.rows[0]).toMatchObject({ reviewerName: "reviewer", clientName: expect.any(String), locationExternalId: expect.stringMatching(/^NS-DEMO-/) });
    expect(all.summary.byReason.map((x: { key: string }) => x.key).sort()).toEqual(["AI_MISSED_EVIDENCE", "IMAGE_INSUFFICIENT"]);

    const overrides = (await app.inject({ url: "/api/feedback?overridesOnly=true", headers: as("lead") })).json();
    expect(overrides.rows.every((r: { isOverride: boolean }) => r.isOverride)).toBe(true);
    const byReason = (await app.inject({ url: "/api/feedback?reason=IMAGE_INSUFFICIENT", headers: as("lead") })).json();
    expect(byReason.rows).toHaveLength(1);
    expect((await app.inject({ url: "/api/feedback?reason=NOPE", headers: as("lead") })).statusCode).toBe(400);
  });

  it("exports CSV and audits the export", async () => {
    const res = await app.inject({ url: "/api/feedback/export.csv?reason=AI_MISSED_EVIDENCE", headers: as("lead") });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="alvip-feedback-/);
    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toMatch(/^createdAt,locationExternalId,clientName,serviceCode/);
    expect(lines.length).toBeGreaterThan(1);
    expect(res.body).toContain(",North and south lawns are one contiguous lawn.,");
    const ev = await t.h.db.select().from(auditEvents).where(eq(auditEvents.eventType, "FEEDBACK_EXPORTED"));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({ rows: lines.length - 1, filter: { reasonCode: "AI_MISSED_EVIDENCE" } });
  });

  it("CSV cells cannot run as spreadsheet formulas", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(true)).toBe("true");
  });
});

describe("location history", () => {
  it("names the people behind audit events", async () => {
    const d = (await app.inject({ url: `/api/locations/${(await loc("NS-DEMO-009")).id}`, headers: as("reviewer") })).json();
    const decision = d.audit.find((a: { eventType: string }) => a.eventType === "HUMAN_DECISION");
    expect(decision.actorName).toBe("reviewer");
    const override = await t.h.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.locationId, (await loc("NS-DEMO-009")).id), eq(auditEvents.eventType, "HUMAN_OVERRIDE")));
    expect(override[0]!.data).toMatchObject({ relevantImageIds: [expect.any(String)] });
  });
});
