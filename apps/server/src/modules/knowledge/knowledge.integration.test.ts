import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { auditEvents, clients, knowledgeNotes, locations } from "../../db/schema";
import { buildApp } from "../../http/app";
import { SESSION_COOKIE } from "../../http/authPlugin";
import { createUser, LoginThrottle } from "../../services/auth";
import { importKnowledge } from "../../services/knowledgeImport";
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
const as = (who: string) => ({ cookie: cookies[who]! });
const loc = async (externalId: string) => (await t.h.db.select().from(locations).where(eq(locations.externalId, externalId)))[0]!;
const clientId = async (code: string) => (await t.h.db.select().from(clients).where(eq(clients.code, code)))[0]!.id;
const create = (who: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/knowledge", headers: as(who), payload });

beforeAll(async () => {
  t = await createHarness({ scenarios: ["NS-DEMO-001", "NS-DEMO-011"].map(scenario) });
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

describe("knowledge notes (PRD §31)", () => {
  let noteId = "";

  it("team leads add notes; reviewers can read but not add", async () => {
    expect((await create("reviewer", { kind: "EDGE_CASE", title: "x", body: "y" })).statusCode).toBe(403);
    const res = await create("lead", {
      kind: "CLIENT_INSTRUCTION",
      title: "Client A: edging along the drive",
      body: "Client A counts the driveway edge as part of edging.",
      clientId: await clientId("DEMO_CLIENT_A"),
      serviceCode: "edging",
      source: "Weekly feedback 2026-09-28",
    });
    expect(res.statusCode).toBe(201);
    noteId = res.json().note.id;
    const ev = await t.h.db.select().from(auditEvents).where(eq(auditEvents.entityId, noteId));
    expect(ev.map((e) => e.eventType)).toEqual(["KNOWLEDGE_NOTE_CREATED"]);
    expect(ev[0]!.actorId).not.toBeNull();
  });

  it("validates scope", async () => {
    expect((await create("lead", { kind: "EDGE_CASE", title: "t", body: "b", serviceCode: "teleporting" })).statusCode).toBe(422);
    expect((await create("lead", { kind: "RULE", title: "t", body: "b" })).statusCode).toBe(400);
    expect((await create("lead", { kind: "EDGE_CASE", title: " ", body: "b" })).statusCode).toBe(400);
  });

  it("searches by words across title and text", async () => {
    await create("lead", { kind: "EDGE_CASE", title: "Wet grass after rain", body: "Clumped clippings are normal after mowing wet grass.", serviceCode: "mowing" });
    const hit = (await app.inject({ url: "/api/knowledge?q=driveway%20edging", headers: as("reviewer") })).json().notes;
    expect(hit.map((n: { id: string }) => n.id)).toEqual([noteId]);
    expect(hit[0]).toMatchObject({ clientName: expect.any(String), serviceName: expect.any(String), authorName: "lead" });
    expect((await app.inject({ url: "/api/knowledge?q=100%25", headers: as("reviewer") })).json().notes).toEqual([]); // % is literal
    expect((await app.inject({ url: "/api/knowledge?kind=EDGE_CASE", headers: as("reviewer") })).json().notes).toHaveLength(1);
  });

  it("revising never overwrites: the old note is archived and superseded", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/knowledge/${noteId}/revise`,
      headers: as("lead"),
      payload: { kind: "CLIENT_INSTRUCTION", title: "Client A: edging along the drive", body: "Client A counts driveway AND walkway edges as edging.", clientId: await clientId("DEMO_CLIENT_A"), serviceCode: "edging" },
    });
    expect(res.statusCode).toBe(201);
    const newId = res.json().note.id;
    const [oldRow] = await t.h.db.select().from(knowledgeNotes).where(eq(knowledgeNotes.id, noteId));
    expect(oldRow!.archivedAt).not.toBeNull();
    expect(oldRow!.archiveReason).toBe("Revised");
    expect(oldRow!.body).toBe("Client A counts the driveway edge as part of edging.");
    expect(res.json().note.supersedesId).toBe(noteId);
    // Archived notes are hidden unless asked for.
    const active = (await app.inject({ url: "/api/knowledge?q=edging", headers: as("reviewer") })).json().notes.map((n: { id: string }) => n.id);
    expect(active).toEqual([newId]);
    const withOld = (await app.inject({ url: "/api/knowledge?q=edging&includeArchived=true", headers: as("reviewer") })).json().notes;
    expect(withOld).toHaveLength(2);
    // An archived note cannot be revised again.
    const again = await app.inject({ method: "POST", url: `/api/knowledge/${noteId}/revise`, headers: as("lead"), payload: { kind: "EDGE_CASE", title: "t", body: "b" } });
    expect(again.statusCode).toBe(409);
    noteId = newId;
  });

  it("the database refuses to change note content or delete notes", async () => {
    expect(await dbError(t.h.db.execute(sql`update knowledge_notes set body = 'rewritten' where id = ${noteId}`))).toMatch(/immutable/);
    expect(await dbError(t.h.db.execute(sql`delete from knowledge_notes where id = ${noteId}`))).toMatch(/cannot be deleted/);
    expect(await dbError(t.h.db.execute(sql`update knowledge_notes set archived_at = null where archived_at is not null`))).toMatch(/immutable/);
    // Archiving an active note is the one permitted change.
    expect(await dbError(t.h.db.execute(sql`update knowledge_notes set archived_at = now(), body = 'sneaky' where id = ${noteId}`))).toMatch(/immutable/);
  });

  it("shows a location only notes for its client (or all clients) and its services, most specific first", async () => {
    await create("lead", { kind: "CLIENT_INSTRUCTION", title: "Client C fertilizer receipts", body: "Ask for the product label photo.", clientId: await clientId("DEMO_CLIENT_C"), serviceCode: "fertilization" });
    await create("lead", { kind: "REVIEWER_NOTE", title: "General: check timestamps", body: "Look at photo times when before/after seem swapped." });
    const forA = (await app.inject({ url: `/api/locations/${(await loc("NS-DEMO-001")).id}/knowledge`, headers: as("reviewer") })).json().notes;
    const titles = forA.map((n: { title: string }) => n.title);
    expect(titles[0]).toBe("Client A: edging along the drive"); // client + service
    expect(titles).toContain("General: check timestamps");
    expect(titles).toContain("Wet grass after rain");
    expect(titles).not.toContain("Client C fertilizer receipts");
    const forC = (await app.inject({ url: `/api/locations/${(await loc("NS-DEMO-011")).id}/knowledge`, headers: as("reviewer") })).json().notes;
    expect(forC.map((n: { title: string }) => n.title)).not.toContain("Client A: edging along the drive");
  });

  it("archiving needs a reason and is audited", async () => {
    const url = `/api/knowledge/${noteId}/archive`;
    expect((await app.inject({ method: "POST", url, headers: as("lead"), payload: { reason: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url, headers: as("reviewer"), payload: { reason: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: as("lead"), payload: { reason: "Client changed contract" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url, headers: as("lead"), payload: { reason: "again" } })).statusCode).toBe(409);
    const ev = await t.h.db.select().from(auditEvents).where(eq(auditEvents.entityId, noteId));
    expect(ev.map((e) => e.eventType)).toContain("KNOWLEDGE_NOTE_ARCHIVED");
  });
});

describe("knowledge import", () => {
  const actor = { type: "SYSTEM" as const, id: "knowledge-import" };

  it("imports nothing when any entry is invalid, and lists every problem", async () => {
    const before = (await t.h.db.select().from(knowledgeNotes)).length;
    const r = await importKnowledge(
      t.h.db,
      actor,
      [
        { kind: "EDGE_CASE", title: "ok", body: "fine" },
        { kind: "EDGE_CASE", title: "bad client", body: "b", client: "NOBODY" },
        { kind: "NOPE", title: "x", body: "y" },
      ],
      "test.json",
    );
    expect(r.imported).toBe(0);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/Note 2: unknown client "NOBODY"/);
    expect((await t.h.db.select().from(knowledgeNotes)).length).toBe(before);
    expect((await importKnowledge(t.h.db, actor, { not: "an array" }, "x")).errors[0]).toMatch(/JSON array/);
  });

  it("imports valid notes once; re-running skips them", async () => {
    const notes = [
      { kind: "HISTORICAL_EXAMPLE", title: "2025 storm cleanup", body: "Debris piles left for pickup still count as removal for Client B.", client: "DEMO_CLIENT_B" },
      { kind: "SERVICE_DEFINITION", title: "Edging", body: "A visible clean line along hard surfaces.", service: "edging", source: "Ops handbook" },
    ];
    expect(await importKnowledge(t.h.db, actor, notes, "Import: notes.json")).toEqual({ imported: 2, skipped: 0, errors: [] });
    expect(await importKnowledge(t.h.db, actor, notes, "Import: notes.json")).toEqual({ imported: 0, skipped: 2, errors: [] });
    const [def] = await t.h.db.select().from(knowledgeNotes).where(eq(knowledgeNotes.title, "Edging"));
    expect(def).toMatchObject({ source: "Ops handbook", authorId: null, kind: "SERVICE_DEFINITION" });
    const [hist] = await t.h.db.select().from(knowledgeNotes).where(eq(knowledgeNotes.title, "2025 storm cleanup"));
    expect(hist!.source).toBe("Import: notes.json");
  });
});
