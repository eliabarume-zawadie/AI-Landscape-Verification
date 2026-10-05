import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { KNOWLEDGE_NOTE_KINDS } from "@alvip/shared";
import { requireRole, requireUser } from "../../http/authPlugin";
import type { AppContext } from "../../http/context";
import { archiveNote, createNote, KnowledgeValidationError, notesForLocation, noteScopes, reviseNote, searchNotes } from "../../services/knowledge";
import { LocationNotFoundError } from "../../services/locationTransitions";

const idParam = z.object({ id: z.string().uuid() });
const noteBody = z.object({
  kind: z.enum(KNOWLEDGE_NOTE_KINDS),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
  clientId: z.string().uuid().nullable().optional(),
  serviceCode: z.string().max(100).nullable().optional(),
  source: z.string().max(300).nullable().optional(),
});
const searchQuery = z.object({
  q: z.string().max(200).optional(),
  clientId: z.string().uuid().optional(),
  serviceCode: z.string().max(100).optional(),
  kind: z.enum(KNOWLEDGE_NOTE_KINDS).optional(),
  includeArchived: z.enum(["true", "false"]).optional(),
});
const archiveBody = z.object({ reason: z.string().trim().min(1).max(500) });

/** PRD §31 knowledge base. Everyone can read; team leads curate. */
export async function knowledgeRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/knowledge", { preHandler: requireUser }, async (req, reply) => {
    const q = searchQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    const { includeArchived, ...rest } = q.data;
    return { notes: await searchNotes(ctx.db, { ...rest, includeArchived: includeArchived === "true" }) };
  });

  app.get("/api/knowledge/scopes", { preHandler: requireUser }, async () => noteScopes(ctx.db));

  app.get("/api/locations/:id/knowledge", { preHandler: requireUser }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    try {
      return { notes: await notesForLocation(ctx.db, p.data.id) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/knowledge", { preHandler: requireRole("TEAM_LEAD") }, async (req, reply) => {
    const body = noteBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: body.error.issues });
    try {
      const note = await createNote(ctx.db, { type: "USER", id: req.user!.id, ip: req.ip }, body.data);
      return reply.code(201).send({ note });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/knowledge/:id/revise", { preHandler: requireRole("TEAM_LEAD") }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const body = noteBody.safeParse(req.body);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!body.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: body.error.issues });
    try {
      const note = await reviseNote(ctx.db, { type: "USER", id: req.user!.id, ip: req.ip }, p.data.id, body.data);
      return reply.code(201).send({ note });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/knowledge/:id/archive", { preHandler: requireRole("TEAM_LEAD") }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const body = archiveBody.safeParse(req.body);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!body.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Say why the note is archived" });
    try {
      await archiveNote(ctx.db, { type: "USER", id: req.user!.id, ip: req.ip }, p.data.id, body.data.reason);
      return { archived: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof LocationNotFoundError) return reply.code(404).send({ error: "NOT_FOUND" });
  if (err instanceof KnowledgeValidationError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "ARCHIVED" ? 409 : 422;
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  throw err;
}
