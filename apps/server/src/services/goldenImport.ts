import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { GOLDEN_CASE_TAGS, GOLDEN_EXPECTED } from "@alvip/shared";
import type { Actor } from "../audit/audit";
import type { Db } from "../db/client";
import { clients, services } from "../db/schema";
import type { StorageProvider } from "../integrations/storage/StorageProvider";
import { _insertExampleForImport, type NewImage } from "./golden";

/**
 * Import labelled historical examples (U11) from a folder: `manifest.json` + photo files.
 * Format: docs/AI_EVALUATION.md. All-or-nothing validation; every example becomes a DRAFT
 * that a team lead reviews and approves before it is used.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

const manifestSchema = z.object({
  examples: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        client: z.string().trim().min(1),
        expected: z.record(z.string(), z.enum(GOLDEN_EXPECTED)).refine((e) => Object.keys(e).length > 0, "needs at least one service"),
        tags: z.array(z.enum(GOLDEN_CASE_TAGS)).default([]),
        reviewerDecision: z.enum(["APPROVE", "REJECT"]).optional(),
        reason: z.string().max(2000).optional(),
        notes: z.string().max(5000).optional(),
        images: z
          .array(z.object({ file: z.string().min(1), capturedAt: z.string().datetime({ offset: true }).optional() }))
          .min(1),
      }),
    )
    .min(1),
});

export async function importGoldenFolder(db: Db, storage: StorageProvider, actor: Actor, dir: string): Promise<{ imported: number; errors: string[] }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  } catch (err) {
    return { imported: 0, errors: [`Cannot read manifest.json: ${(err as Error).message}`] };
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) return { imported: 0, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };

  const clientIds = new Map((await db.select({ id: clients.id, code: clients.code }).from(clients)).map((c) => [c.code, c.id]));
  const known = new Set((await db.select({ code: services.code }).from(services).where(eq(services.active, true))).map((s) => s.code));
  const errors: string[] = [];
  const ready: { ex: (typeof parsed.data.examples)[number]; clientId: string; images: NewImage[] }[] = [];
  const root = path.resolve(dir);

  for (const [i, ex] of parsed.data.examples.entries()) {
    const at = `Example ${i + 1} ("${ex.title}")`;
    const clientId = clientIds.get(ex.client);
    if (!clientId) errors.push(`${at}: unknown client "${ex.client}"`);
    for (const s of Object.keys(ex.expected)) if (!known.has(s)) errors.push(`${at}: unknown service "${s}"`);
    const imgs: NewImage[] = [];
    for (const img of ex.images) {
      const file = path.resolve(root, img.file);
      const type = CONTENT_TYPES[path.extname(file).toLowerCase()];
      if (!file.startsWith(root + path.sep)) {
        errors.push(`${at}: photo path "${img.file}" is outside the import folder`);
        continue;
      }
      if (!type) {
        errors.push(`${at}: "${img.file}" is not a supported photo type (jpg, png, webp, heic)`);
        continue;
      }
      try {
        imgs.push({ externalRef: path.basename(img.file), filename: path.basename(img.file), capturedAt: img.capturedAt ? new Date(img.capturedAt) : null, contentType: type, bytes: await readFile(file) });
      } catch {
        errors.push(`${at}: photo "${img.file}" not found`);
      }
    }
    if (clientId) ready.push({ ex, clientId, images: imgs });
  }
  if (errors.length) return { imported: 0, errors };

  await db.transaction(async (tx) => {
    for (const { ex, clientId, images } of ready) {
      await _insertExampleForImport(tx, storage, actor, {
        title: ex.title,
        clientId,
        source: "IMPORT",
        services: Object.keys(ex.expected).sort(),
        expected: ex.expected,
        tags: ex.tags,
        reviewerDecision: ex.reviewerDecision ?? null,
        reason: ex.reason ?? null,
        notes: ex.notes ?? null,
        images,
      });
    }
  });
  return { imported: ready.length, errors: [] };
}
