import { eq } from "drizzle-orm";
import type { ErrorCategory } from "@alvip/shared";
import { recordAudit, type Actor } from "../audit/audit";
import { loadActiveConfig, type ActiveConfig } from "../config/configStore";
import type { Db } from "../db/client";
import { clients, locations, locationServices } from "../db/schema";
import { resolveRequiredServices } from "../domain/serviceRegistry";
import type { NetSuiteAdapter, NetSuiteLocation, NetSuiteQueueItem } from "../integrations/netsuite/NetSuiteAdapter";
import type { QueueProvider } from "../integrations/queue/QueueProvider";
import { JOB_TYPES, type ProcessLocationPayload } from "../pipeline/jobTypes";
import { classifyError, recordSystemError } from "./errors";
import { transitionLocation } from "./locationTransitions";

export interface IngestDeps {
  db: Db;
  netsuite: NetSuiteAdapter;
  queue: QueueProvider;
  actor: Actor;
}

export interface IngestSummary {
  listed: number;
  created: number;
  queued: number;
  exceptions: number;
  alreadyKnown: number;
  fetchFailures: number;
}

/**
 * Pull the NetSuite queue and create one location per new work item (PRD §12).
 * Idempotent: items already known by external ID are skipped. Items that cannot be
 * verified safely (unknown client, unknown service, no services) go to the Exception
 * Lane instead of being dropped or partially verified.
 */
export async function ingestQueue(deps: IngestDeps): Promise<IngestSummary> {
  const items = await deps.netsuite.getQueue();
  const config = await loadActiveConfig(deps.db);
  const summary: IngestSummary = { listed: items.length, created: 0, queued: 0, exceptions: 0, alreadyKnown: 0, fetchFailures: 0 };

  // Oldest first, so ties in the job queue also favour older work.
  const ordered = [...items].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  for (const item of ordered) {
    const [existing] = await deps.db
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.externalId, item.externalId));
    if (existing) {
      summary.alreadyKnown++;
      continue;
    }

    let details: NetSuiteLocation;
    let sourceServices: string[];
    try {
      details = await deps.netsuite.getLocation(item.externalId);
      sourceServices = await deps.netsuite.getRequiredServices(item.externalId);
    } catch (err) {
      // Nothing is persisted, so the next poll retries naturally.
      const c = classifyError(err);
      summary.fetchFailures++;
      await recordSystemError(deps.db, {
        category: c.category,
        source: "ingest",
        message: c.message,
        details: { externalId: item.externalId },
        actor: deps.actor,
      });
      continue;
    }

    const result = await createLocation(deps, config, item, details, sourceServices);
    if (result === "exists") summary.alreadyKnown++;
    else {
      summary.created++;
      if (result === "queued") summary.queued++;
      else summary.exceptions++;
    }
  }
  return summary;
}

async function createLocation(
  deps: IngestDeps,
  config: ActiveConfig,
  item: NetSuiteQueueItem,
  details: NetSuiteLocation,
  sourceServices: string[],
): Promise<"exists" | "queued" | "exception"> {
  return deps.db.transaction(async (tx) => {
    const clientCode = details.clientCode || item.clientCode;
    const clientId = await findOrCreateClient(tx, clientCode);

    const [loc] = await tx
      .insert(locations)
      .values({
        externalId: item.externalId,
        externalLocationRef: details.externalLocationRef ?? null,
        clientId,
        name: details.name ?? null,
        serviceDate: details.serviceDate ?? null,
        receivedAt: item.receivedAt,
        sourceSnapshot: (details.raw ?? null) as object | null,
      })
      .onConflictDoNothing({ target: locations.externalId })
      .returning({ id: locations.id });
    if (!loc) return "exists";

    const problems: { category: ErrorCategory; message: string }[] = [];
    const profile = config.clientProfiles.get(clientCode);
    let services: string[] = [];
    let servicesSource: "SOURCE_SYSTEM" | "CLIENT_PROFILE" = "SOURCE_SYSTEM";

    if (!profile) {
      problems.push({ category: "CONFIGURATION", message: `No client profile configured for client "${clientCode}"` });
    } else {
      const resolved = resolveRequiredServices(config.registry, profile.profile, sourceServices);
      services = resolved.services;
      servicesSource = resolved.source;
      if (resolved.unknown.length > 0) {
        problems.push({
          category: "CONFIGURATION",
          message: `Unknown service code(s) from ${resolved.source}: ${resolved.unknown.join(", ")}`,
        });
      }
      if (services.length === 0 && resolved.unknown.length === 0) {
        problems.push({ category: "CONFIGURATION", message: "No required services for this location" });
      }
    }

    if (services.length > 0) {
      await tx
        .insert(locationServices)
        .values(services.map((serviceCode) => ({ locationId: loc.id, serviceCode, source: servicesSource })));
    }

    await recordAudit(tx, {
      eventType: "LOCATION_RECEIVED",
      actor: deps.actor,
      entityType: "locations",
      entityId: loc.id,
      locationId: loc.id,
      data: {
        externalId: item.externalId,
        client: clientCode,
        clientProfileVersion: profile?.version ?? null,
        services,
        servicesSource,
        sourceServices,
      },
    });

    if (problems.length > 0) {
      for (const p of problems) {
        await recordSystemError(tx, {
          ...p,
          source: "ingest",
          locationId: loc.id,
          details: { externalId: item.externalId },
          actor: deps.actor,
        });
      }
      await transitionLocation(tx, {
        locationId: loc.id,
        to: "INTEGRATION_ERROR",
        actor: deps.actor,
        reason: problems.map((p) => p.message).join("; "),
      });
      return "exception";
    }

    await transitionLocation(tx, { locationId: loc.id, to: "QUEUED", actor: deps.actor, reason: "received from queue" });
    const payload: ProcessLocationPayload = { locationId: loc.id, reason: "INITIAL" };
    await deps.queue.enqueue(
      {
        type: JOB_TYPES.PROCESS_LOCATION,
        payload: { ...payload },
        idempotencyKey: `process:${loc.id}:initial`,
        priority: profile!.profile.priority,
        locationId: loc.id,
      },
      tx,
    );
    return "queued";
  });
}

async function findOrCreateClient(tx: Db, code: string): Promise<string> {
  const [found] = await tx.select({ id: clients.id }).from(clients).where(eq(clients.code, code));
  if (found) return found.id;
  // Unknown clients are recorded so the work item is visible; it goes to the Exception Lane.
  const [created] = await tx
    .insert(clients)
    .values({ code, displayName: code })
    .onConflictDoUpdate({ target: clients.code, set: { code } })
    .returning({ id: clients.id });
  return created!.id;
}
