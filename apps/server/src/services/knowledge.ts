import { aliasedTable, and, desc, eq, ilike, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { KnowledgeNoteKind } from "@alvip/shared";
import { recordAudit, type Actor } from "../audit/audit";
import type { Db } from "../db/client";
import { clients, knowledgeNotes, locations, locationServices, services, users } from "../db/schema";
import { LocationNotFoundError } from "./locationTransitions";

/**
 * Historical notes knowledge base (PRD §31).
 *
 * Notes are guidance for reviewers. They never change how locations are assessed: the
 * pipeline, the evidence engine and the risk engine do not read this table, and client
 * rules come only from the versioned client profiles (changing those is a deliberate,
 * audited config change). Notes are not sent to the AI; doing so would need evaluation
 * (Phase 13) and must keep them subordinate to the active client configuration.
 */

export class KnowledgeValidationError extends Error {
  override name = "KnowledgeValidationError";
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "INVALID" | "ARCHIVED",
  ) {
    super(message);
  }
}

export interface NoteInput {
  kind: KnowledgeNoteKind;
  title: string;
  body: string;
  clientId?: string | null;
  serviceCode?: string | null;
  source?: string | null;
}

async function validateScope(db: Db, input: NoteInput) {
  if (!input.title.trim() || !input.body.trim()) throw new KnowledgeValidationError("Title and text are required", "INVALID");
  if (input.clientId) {
    const [c] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, input.clientId));
    if (!c) throw new KnowledgeValidationError("Unknown client", "INVALID");
  }
  if (input.serviceCode) {
    const [s] = await db.select({ code: services.code }).from(services).where(eq(services.code, input.serviceCode));
    if (!s) throw new KnowledgeValidationError(`Unknown service ${input.serviceCode}`, "INVALID");
  }
}

export async function createNote(db: Db, actor: Actor, input: NoteInput, supersedesId: string | null = null) {
  await validateScope(db, input);
  const [note] = await db
    .insert(knowledgeNotes)
    .values({
      kind: input.kind,
      title: input.title.trim(),
      body: input.body.trim(),
      clientId: input.clientId ?? null,
      serviceCode: input.serviceCode ?? null,
      source: input.source?.trim() || null,
      authorId: actor.type === "USER" ? actor.id : null,
      supersedesId,
    })
    .returning();
  await recordAudit(db, {
    eventType: "KNOWLEDGE_NOTE_CREATED",
    actor,
    entityType: "knowledge_notes",
    entityId: note!.id,
    data: { kind: note!.kind, title: note!.title, clientId: note!.clientId, serviceCode: note!.serviceCode, supersedesId },
  });
  return note!;
}

async function activeNote(db: Db, id: string) {
  const [note] = await db.select().from(knowledgeNotes).where(eq(knowledgeNotes.id, id));
  if (!note) throw new KnowledgeValidationError("Note not found", "NOT_FOUND");
  if (note.archivedAt) throw new KnowledgeValidationError("This note is archived", "ARCHIVED");
  return note;
}

async function archive(db: Db, actor: Actor & { type: "USER" }, id: string, reason: string) {
  const done = await db
    .update(knowledgeNotes)
    .set({ archivedAt: new Date(), archivedBy: actor.id, archiveReason: reason })
    .where(and(eq(knowledgeNotes.id, id), isNull(knowledgeNotes.archivedAt)))
    .returning({ id: knowledgeNotes.id });
  // Someone else archived or revised it first; the transaction rolls back.
  if (done.length === 0) throw new KnowledgeValidationError("This note was changed by someone else", "ARCHIVED");
  await recordAudit(db, { eventType: "KNOWLEDGE_NOTE_ARCHIVED", actor, entityType: "knowledge_notes", entityId: id, data: { reason } });
}

export async function archiveNote(db: Db, actor: Actor & { type: "USER" }, id: string, reason: string) {
  if (!reason.trim()) throw new KnowledgeValidationError("Say why the note is archived", "INVALID");
  await activeNote(db, id);
  await db.transaction((tx) => archive(tx, actor, id, reason.trim()));
}

/** Revising never overwrites: the old note is archived and a new one supersedes it. */
export async function reviseNote(db: Db, actor: Actor & { type: "USER" }, id: string, input: NoteInput) {
  await activeNote(db, id);
  return db.transaction(async (tx) => {
    const note = await createNote(tx, actor, input, id);
    await archive(tx, actor, id, "Revised");
    return note;
  });
}

export interface NoteSearch {
  q?: string;
  clientId?: string;
  serviceCode?: string;
  kind?: KnowledgeNoteKind;
  includeArchived?: boolean;
  limit?: number;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

const author = aliasedTable(users, "author");

function noteColumns() {
  return {
    id: knowledgeNotes.id,
    kind: knowledgeNotes.kind,
    title: knowledgeNotes.title,
    body: knowledgeNotes.body,
    source: knowledgeNotes.source,
    clientId: knowledgeNotes.clientId,
    clientName: clients.displayName,
    serviceCode: knowledgeNotes.serviceCode,
    serviceName: services.displayName,
    authorName: author.displayName,
    supersedesId: knowledgeNotes.supersedesId,
    createdAt: knowledgeNotes.createdAt,
    archivedAt: knowledgeNotes.archivedAt,
    archiveReason: knowledgeNotes.archiveReason,
  };
}

function noteQuery(db: Db, where: SQL | undefined) {
  return db
    .select(noteColumns())
    .from(knowledgeNotes)
    .leftJoin(clients, eq(clients.id, knowledgeNotes.clientId))
    .leftJoin(services, eq(services.code, knowledgeNotes.serviceCode))
    .leftJoin(author, eq(author.id, knowledgeNotes.authorId))
    .where(where);
}

/** Every word must appear in the title or the text (case-insensitive). */
export async function searchNotes(db: Db, s: NoteSearch) {
  const conditions: SQL[] = [];
  for (const word of (s.q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
    const pattern = `%${escapeLike(word)}%`;
    conditions.push(or(ilike(knowledgeNotes.title, pattern), ilike(knowledgeNotes.body, pattern))!);
  }
  if (s.clientId) conditions.push(eq(knowledgeNotes.clientId, s.clientId));
  if (s.serviceCode) conditions.push(eq(knowledgeNotes.serviceCode, s.serviceCode));
  if (s.kind) conditions.push(eq(knowledgeNotes.kind, s.kind));
  if (!s.includeArchived) conditions.push(isNull(knowledgeNotes.archivedAt));
  return noteQuery(db, conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(knowledgeNotes.createdAt))
    .limit(Math.min(s.limit ?? 100, 500));
}

/**
 * Active notes relevant to a location: for its client (or all clients) and for one of its
 * required services (or all services). Notes for other clients are never shown. Most
 * specific first: client + service, client, service, general.
 */
export async function notesForLocation(db: Db, locationId: string, limit = 10) {
  const [loc] = await db.select({ clientId: locations.clientId }).from(locations).where(eq(locations.id, locationId));
  if (!loc) throw new LocationNotFoundError(`Location ${locationId} not found`);
  const svc = (await db.select({ code: locationServices.serviceCode }).from(locationServices).where(eq(locationServices.locationId, locationId))).map(
    (r) => r.code,
  );
  const rows = await noteQuery(
    db,
    and(
      isNull(knowledgeNotes.archivedAt),
      or(isNull(knowledgeNotes.clientId), eq(knowledgeNotes.clientId, loc.clientId)),
      svc.length ? or(isNull(knowledgeNotes.serviceCode), inArray(knowledgeNotes.serviceCode, svc)) : isNull(knowledgeNotes.serviceCode),
    ),
  ).orderBy(desc(knowledgeNotes.createdAt));
  const specificity = (n: { clientId: string | null; serviceCode: string | null }) => (n.clientId ? 2 : 0) + (n.serviceCode ? 1 : 0);
  return rows.sort((a, b) => specificity(b) - specificity(a)).slice(0, limit);
}

export async function noteScopes(db: Db) {
  const [c, s] = await Promise.all([
    db.select({ id: clients.id, code: clients.code, name: clients.displayName }).from(clients).orderBy(clients.displayName),
    db.select({ code: services.code, name: services.displayName }).from(services).where(eq(services.active, true)).orderBy(services.displayName),
  ]);
  return { clients: c, services: s };
}
