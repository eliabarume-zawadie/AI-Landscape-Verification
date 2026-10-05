import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { KNOWLEDGE_NOTE_KINDS } from "@alvip/shared";
import type { Actor } from "../audit/audit";
import type { Db } from "../db/client";
import { clients, knowledgeNotes, services } from "../db/schema";
import { createNote } from "./knowledge";

/**
 * Import of historical reviewer notes (PRD §31). Their real format is unknown (U10), so this
 * reads a documented JSON array (docs/KNOWLEDGE_BASE.md). All-or-nothing: if any entry is
 * invalid nothing is imported, and every problem is listed. Re-running skips notes that are
 * already present (same kind, scope, title and text).
 */
const entrySchema = z.object({
  kind: z.enum(KNOWLEDGE_NOTE_KINDS),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
  client: z.string().trim().min(1).optional(),
  service: z.string().trim().min(1).optional(),
  source: z.string().trim().max(300).optional(),
});
export type ImportEntry = z.infer<typeof entrySchema>;

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export async function importKnowledge(db: Db, actor: Actor, data: unknown, defaultSource: string): Promise<ImportResult> {
  const parsed = z.array(z.unknown()).safeParse(data);
  if (!parsed.success) return { imported: 0, skipped: 0, errors: ["The file must contain a JSON array of notes"] };

  const clientRows = await db.select({ id: clients.id, code: clients.code }).from(clients);
  const serviceRows = await db.select({ code: services.code }).from(services);
  const clientByCode = new Map(clientRows.map((c) => [c.code, c.id]));
  const serviceCodes = new Set(serviceRows.map((s) => s.code));

  const errors: string[] = [];
  const ready: { entry: ImportEntry; clientId: string | null }[] = [];
  parsed.data.forEach((raw, i) => {
    const r = entrySchema.safeParse(raw);
    if (!r.success) {
      errors.push(`Note ${i + 1}: ${r.error.issues.map((x) => `${x.path.join(".") || "entry"} ${x.message}`).join("; ")}`);
      return;
    }
    const clientId = r.data.client ? (clientByCode.get(r.data.client) ?? null) : null;
    if (r.data.client && !clientId) errors.push(`Note ${i + 1}: unknown client "${r.data.client}"`);
    if (r.data.service && !serviceCodes.has(r.data.service)) errors.push(`Note ${i + 1}: unknown service "${r.data.service}"`);
    ready.push({ entry: r.data, clientId });
  });
  if (errors.length) return { imported: 0, skipped: 0, errors };

  return db.transaction(async (tx) => {
    let imported = 0;
    let skipped = 0;
    for (const { entry, clientId } of ready) {
      const [existing] = await tx
        .select({ id: knowledgeNotes.id })
        .from(knowledgeNotes)
        .where(
          and(
            isNull(knowledgeNotes.archivedAt),
            eq(knowledgeNotes.kind, entry.kind),
            eq(knowledgeNotes.title, entry.title),
            eq(knowledgeNotes.body, entry.body),
            clientId ? eq(knowledgeNotes.clientId, clientId) : isNull(knowledgeNotes.clientId),
            entry.service ? eq(knowledgeNotes.serviceCode, entry.service) : isNull(knowledgeNotes.serviceCode),
          ),
        )
        .limit(1);
      if (existing) {
        skipped++;
        continue;
      }
      await createNote(tx, actor, {
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        clientId,
        serviceCode: entry.service ?? null,
        source: entry.source ?? defaultSource,
      });
      imported++;
    }
    return { imported, skipped, errors: [] };
  });
}
