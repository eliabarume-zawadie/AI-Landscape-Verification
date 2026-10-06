import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { GOLDEN_CASE_TAGS, GOLDEN_EXPECTED, GOLDEN_STATUSES } from "@alvip/shared";
import { requireRole } from "../../http/authPlugin";
import type { AppContext } from "../../http/context";
import { openImage } from "../../pipeline/imageDecode";
import { EvaluationError, getEvaluationRun, listEvaluationRuns, requestEvaluation } from "../../services/evaluation";
import { approveExample, createFromLocation, exampleImageBytes, getExample, GoldenError, listExamples, retireExample, seedDemoExamples, updateDraft } from "../../services/golden";
import { LocationNotFoundError } from "../../services/locationTransitions";

const idParam = z.object({ id: z.string().uuid() });
const draftBody = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  expected: z.record(z.string(), z.enum(GOLDEN_EXPECTED)).optional(),
  tags: z.array(z.enum(GOLDEN_CASE_TAGS)).max(20).optional(),
  reason: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});
const runBody = z.object({
  label: z.string().max(200).optional(),
  includeDemo: z.boolean().optional(),
  clientId: z.string().uuid().optional(),
  tags: z.array(z.enum(GOLDEN_CASE_TAGS)).max(20).optional(),
  visionModel: z.string().trim().min(1).max(200).optional(),
  acknowledgeCost: z.boolean().optional(),
});

/** PRD §55–56: golden dataset and evaluation runs. Team leads; model trials are admin-only. */
export async function evaluationRoutes(app: FastifyInstance, ctx: AppContext) {
  const lead = { preHandler: requireRole("TEAM_LEAD") };
  const actor = (req: { user?: { id: string } | null; ip: string }) => ({ type: "USER" as const, id: req.user!.id, ip: req.ip });

  app.get("/api/golden", lead, async (req, reply) => {
    const q = z.object({ status: z.enum(GOLDEN_STATUSES).optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    return { examples: await listExamples(ctx.db, q.data.status ? { status: q.data.status } : {}) };
  });

  app.post("/api/golden/from-location/:id", lead, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    const b = z.object({ title: z.string().max(300).optional() }).safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try {
      const id = await createFromLocation(ctx.db, ctx.integrations.storage, actor(req), p.data.id, b.data.title ? { title: b.data.title } : {});
      return reply.code(201).send({ id });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/golden/demo", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    if (!ctx.env.MOCK_IMAGES) return reply.code(409).send({ error: "MOCK_ONLY", message: "Demo examples need the mock image source (MOCK_IMAGES=true)." });
    try {
      return await seedDemoExamples(ctx.db, ctx.integrations.storage, ctx.integrations.images, actor(req));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/golden/:id", lead, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    try {
      return await getExample(ctx.db, p.data.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch("/api/golden/:id", lead, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = draftBody.safeParse(req.body);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!b.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: b.error.issues });
    try {
      await updateDraft(ctx.db, actor(req), p.data.id, Object.fromEntries(Object.entries(b.data).filter(([, v]) => v !== undefined)));
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/golden/:id/approve", lead, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    try {
      await approveExample(ctx.db, actor(req), req.user!.role, p.data.id);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/golden/:id/retire", lead, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ reason: z.string().trim().min(1).max(500) }).safeParse(req.body);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!b.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Say why the example is retired" });
    try {
      await retireExample(ctx.db, actor(req), p.data.id, b.data.reason);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Photos are always re-encoded as JPEG (HEIC etc. display everywhere). */
  app.get("/api/golden/images/:id/content", lead, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const q = z.object({ variant: z.enum(["thumb", "full"]).default("thumb") }).safeParse(req.query);
    if (!p.success || !q.success) return reply.code(404).send({ error: "NOT_FOUND" });
    const bytes = await exampleImageBytes(ctx.db, ctx.integrations.storage, p.data.id);
    if (!bytes) return reply.code(404).send({ error: "NOT_FOUND" });
    try {
      const opened = await openImage(bytes, { maxInputPixels: 100_000_000 });
      const img = q.data.variant === "thumb" ? opened.image().resize({ width: 360, withoutEnlargement: true }) : opened.image();
      const body = await img.jpeg({ quality: q.data.variant === "thumb" ? 80 : 90 }).toBuffer();
      return reply.header("Content-Type", "image/jpeg").header("Cache-Control", "private, no-store").send(body);
    } catch {
      return reply.code(422).send({ error: "UNDECODABLE_IMAGE" });
    }
  });

  app.get("/api/evaluations/vision", lead, async () => ctx.integrations.vision.info);

  app.get("/api/evaluations", lead, async () => ({ runs: await listEvaluationRuns(ctx.db) }));

  app.post("/api/evaluations", lead, async (req, reply) => {
    const b = runBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: b.error.issues });
    if (b.data.visionModel && req.user!.role !== "ADMIN") return reply.code(403).send({ error: "FORBIDDEN", message: "Only admins can trial another model." });
    try {
      const run = await requestEvaluation(ctx.db, ctx.queue, ctx.env, ctx.integrations, actor(req), Object.fromEntries(Object.entries(b.data).filter(([, v]) => v !== undefined)));
      return reply.code(202).send({ id: run.id });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/evaluations/:id", lead, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    try {
      return await getEvaluationRun(ctx.db, p.data.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof LocationNotFoundError) return reply.code(404).send({ error: "NOT_FOUND" });
  if (err instanceof GoldenError) {
    const status = { NOT_FOUND: 404, INVALID: 422, STATE: 409, FORBIDDEN: 403 }[err.code];
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  if (err instanceof EvaluationError) {
    const status = { NOT_FOUND: 404, NO_EXAMPLES: 422, BUSY: 409, COST_NOT_ACKNOWLEDGED: 428 }[err.code];
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  throw err;
}
