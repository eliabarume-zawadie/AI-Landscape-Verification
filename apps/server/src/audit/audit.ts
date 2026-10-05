import type { AuditEventType } from "@alvip/shared";
import type { Db } from "../db/client";
import { auditEvents } from "../db/schema";

export type Actor =
  | { type: "USER"; id: string; ip?: string | undefined }
  | { type: "SYSTEM"; id?: string }
  | { type: "WORKER"; id: string };

export interface AuditInput {
  eventType: AuditEventType;
  actor: Actor;
  entityType?: string;
  entityId?: string;
  locationId?: string;
  runId?: string;
  data?: Record<string, unknown>;
}

/**
 * Append an audit event. Pass the transaction handle when the audited change is
 * transactional so the event commits (or rolls back) with it.
 */
export async function recordAudit(db: Db, input: AuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    eventType: input.eventType,
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    locationId: input.locationId ?? null,
    runId: input.runId ?? null,
    data: input.data ?? {},
    ip: input.actor.type === "USER" ? (input.actor.ip ?? null) : null,
  });
}

export const SYSTEM_ACTOR: Actor = { type: "SYSTEM" };
