import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit/audit";
import { imageAnalysis, images, locations, processingRuns } from "../../db/schema";
import { requireUser } from "../../http/authPlugin";
import { openImage } from "../../pipeline/imageDecode";
import type { AppContext } from "../../http/context";

const listParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({ runId: z.string().uuid().optional() });
const contentParams = z.object({ id: z.string().uuid(), imageId: z.string().uuid() });
const contentQuery = z.object({ variant: z.enum(["full", "thumb"]).default("full") });

/** Formats browsers display natively; anything else is transcoded to JPEG for viewing. */
const BROWSER_FORMATS: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const THUMB_WIDTH = 360;
/** Same decompression-bomb guard as analysis (thresholds default). */
const MAX_VIEW_PIXELS = 50_000_000;

export async function imageRoutes(app: FastifyInstance, ctx: AppContext) {
  /** PRD §76: images for a location with per-run quality and duplicate analysis. */
  app.get("/api/locations/:id/images", { preHandler: requireUser }, async (req, reply) => {
    const p = listParams.safeParse(req.params);
    const q = listQuery.safeParse(req.query);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!q.success) return reply.code(400).send({ error: "INVALID_REQUEST" });

    const [loc] = await ctx.db
      .select({ id: locations.id, currentRunId: locations.currentRunId })
      .from(locations)
      .where(eq(locations.id, p.data.id));
    if (!loc) return reply.code(404).send({ error: "NOT_FOUND" });

    const runId = q.data.runId ?? loc.currentRunId;
    if (q.data.runId) {
      const [run] = await ctx.db
        .select({ id: processingRuns.id })
        .from(processingRuns)
        .where(and(eq(processingRuns.id, q.data.runId), eq(processingRuns.locationId, loc.id)));
      if (!run) return reply.code(404).send({ error: "NOT_FOUND" });
    }

    const rows = await ctx.db
      .select({
        id: images.id,
        externalRef: images.externalRef,
        filename: images.filename,
        ordinal: images.ordinal,
        capturedAt: images.capturedAt,
        format: images.format,
        width: images.width,
        height: images.height,
        bytes: images.bytes,
        storageKey: images.storageKey,
        purgedAt: images.purgedAt,
        downloadError: images.downloadError,
        qualityScore: imageAnalysis.qualityScore,
        usable: imageAnalysis.usable,
        qualityIssues: imageAnalysis.qualityIssues,
        duplicateGroup: imageAnalysis.duplicateGroup,
        isDuplicateRepresentative: imageAnalysis.isDuplicateRepresentative,
        duplicateKind: imageAnalysis.duplicateKind,
      })
      .from(images)
      .leftJoin(imageAnalysis, and(eq(imageAnalysis.imageId, images.id), eq(imageAnalysis.runId, runId ?? images.id)))
      .where(eq(images.locationId, loc.id))
      .orderBy(asc(images.ordinal), asc(images.externalRef));

    const items = rows.map(({ storageKey, ...r }) => ({
      ...r,
      contentAvailable: storageKey !== null && r.purgedAt === null,
      analysis:
        r.usable === null
          ? null
          : {
              qualityScore: r.qualityScore,
              usable: r.usable,
              issues: r.qualityIssues,
              duplicateGroup: r.duplicateGroup,
              isDuplicateRepresentative: r.isDuplicateRepresentative,
              duplicateKind: r.duplicateKind,
            },
    }));
    const analysed = items.filter((i) => i.analysis);
    return {
      runId,
      summary: {
        total: items.length,
        usable: analysed.filter((i) => i.analysis!.usable).length,
        unusable: analysed.filter((i) => !i.analysis!.usable).length,
        uniqueClusters: new Set(analysed.map((i) => i.analysis!.duplicateGroup)).size,
        duplicates: analysed.filter((i) => !i.analysis!.isDuplicateRepresentative).length,
      },
      items: items.map(({ qualityScore: _q, usable: _u, qualityIssues: _i, duplicateGroup: _g, isDuplicateRepresentative: _r, duplicateKind: _k, ...rest }) => rest),
    };
  });

  /** Authenticated image bytes. Never a public URL (PRD §50). */
  app.get("/api/locations/:id/images/:imageId/content", { preHandler: requireUser }, async (req, reply) => {
    const p = contentParams.safeParse(req.params);
    const q = contentQuery.safeParse(req.query);
    if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!q.success) return reply.code(400).send({ error: "INVALID_REQUEST" });

    const [img] = await ctx.db
      .select({ storageKey: images.storageKey, purgedAt: images.purgedAt, format: images.format })
      .from(images)
      .where(and(eq(images.id, p.data.imageId), eq(images.locationId, p.data.id)));
    if (!img) return reply.code(404).send({ error: "NOT_FOUND" });
    if (img.purgedAt) return reply.code(410).send({ error: "PURGED_UNDER_RETENTION_POLICY" });
    if (!img.storageKey) return reply.code(404).send({ error: "NOT_DOWNLOADED" });

    const bytes = await ctx.integrations.storage.get(img.storageKey);
    if (!bytes) return reply.code(404).send({ error: "NOT_DOWNLOADED" });

    let body: Buffer;
    let contentType: string;
    try {
      if (q.data.variant === "full" && img.format && BROWSER_FORMATS[img.format]) {
        body = bytes;
        contentType = BROWSER_FORMATS[img.format]!;
      } else {
        // Thumbnails, and formats browsers can't show (e.g. iPhone HEIC), are served as JPEG.
        const opened = await openImage(bytes, { maxInputPixels: MAX_VIEW_PIXELS });
        const pipeline = q.data.variant === "thumb" ? opened.image().resize({ width: THUMB_WIDTH, withoutEnlargement: true }) : opened.image();
        body = await pipeline.jpeg({ quality: q.data.variant === "thumb" ? 80 : 90 }).toBuffer();
        contentType = "image/jpeg";
      }
    } catch {
      return reply.code(422).send({ error: "UNDECODABLE_IMAGE" });
    }

    if (q.data.variant === "full") {
      await recordAudit(ctx.db, {
        eventType: "EVIDENCE_VIEWED",
        actor: { type: "USER", id: req.user!.id, ip: req.ip },
        entityType: "images",
        entityId: p.data.imageId,
        locationId: p.data.id,
      });
    }
    return reply
      .header("Content-Type", contentType)
      .header("Content-Disposition", "inline")
      .header("Cache-Control", "private, no-store")
      .send(body);
  });
}
