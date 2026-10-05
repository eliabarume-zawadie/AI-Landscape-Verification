import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { LocationStatus } from "@alvip/shared";
import { recordAudit, type Actor } from "../audit/audit";
import type { Db } from "../db/client";
import { images, locations } from "../db/schema";
import type { StorageProvider } from "../integrations/storage/StorageProvider";

/**
 * Locations whose images may be purged. Anything still in processing, review,
 * escalation, or awaiting sync keeps its images regardless of age so reviewers are
 * never left without evidence (plan assumption A6).
 */
export const PURGEABLE_STATUSES: readonly LocationStatus[] = ["COMPLETED", "SYNCED_TO_NETSUITE"];

/**
 * PRD §51: delete image bytes older than the retention window. Hashes, metadata, and
 * analysis results are kept; `images.purged_at` records the deletion.
 */
export async function purgeExpiredImages(
  db: Db,
  storage: StorageProvider,
  opts: { retentionDays: number; actor: Actor; batchSize?: number },
): Promise<{ purged: number; locations: number }> {
  const due = await db
    .select({ id: images.id, storageKey: images.storageKey, locationId: images.locationId })
    .from(images)
    .innerJoin(locations, eq(locations.id, images.locationId))
    .where(
      and(
        isNull(images.purgedAt),
        isNotNull(images.storageKey),
        lt(images.downloadedAt, sql`now() - (${opts.retentionDays} * interval '1 day')`),
        inArray(locations.status, [...PURGEABLE_STATUSES]),
      ),
    )
    .limit(opts.batchSize ?? 1000);

  for (const img of due) {
    await storage.delete(img.storageKey!);
    await db.update(images).set({ purgedAt: sql`now()`, storageKey: null }).where(eq(images.id, img.id));
  }

  const locationIds = new Set(due.map((d) => d.locationId));
  if (due.length > 0) {
    await recordAudit(db, {
      eventType: "IMAGES_PURGED",
      actor: opts.actor,
      data: { images: due.length, locations: locationIds.size, retentionDays: opts.retentionDays },
    });
  }
  return { purged: due.length, locations: locationIds.size };
}
