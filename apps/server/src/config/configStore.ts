import { and, eq, max } from "drizzle-orm";
import {
  clientProfileSchema,
  serviceRuleSetSchema,
  thresholdsSchema,
  type ClientProfile,
  type Thresholds,
} from "@alvip/shared";
import { recordAudit, type Actor } from "../audit/audit";
import type { Db } from "../db/client";
import {
  clientProfiles,
  clients,
  serviceRuleVersions,
  services,
  thresholdVersions,
} from "../db/schema";
import { ServiceRegistry, validateClientProfileAgainstRegistry } from "../domain/serviceRegistry";
import { ConfigError } from "./env";
import type { VerificationConfig } from "./verificationConfig";

export interface SyncSummary {
  serviceRules: "created" | "unchanged";
  thresholds: "created" | "unchanged";
  clientProfiles: Record<string, "created" | "unchanged">;
}

/**
 * Write file-based config into the database as new immutable versions, activating
 * them. Unchanged content (same hash as the active version) is a no-op, so this is
 * safe to run repeatedly. Every new version emits a CONFIG_CHANGED audit event.
 */
export async function syncConfigToDb(
  db: Db,
  config: VerificationConfig,
  actor: Actor,
): Promise<SyncSummary> {
  return db.transaction(async (tx) => {
    const summary: SyncSummary = {
      serviceRules: "unchanged",
      thresholds: "unchanged",
      clientProfiles: {},
    };

    // Service registry rows (codes are referenced by FKs; never deleted, only deactivated).
    for (const svc of config.registry.list()) {
      await tx
        .insert(services)
        .values({ code: svc.code, displayName: svc.display_name, active: true })
        .onConflictDoUpdate({
          target: services.code,
          set: { displayName: svc.display_name, active: true },
        });
    }

    // Service rule set
    const [activeRules] = await tx
      .select()
      .from(serviceRuleVersions)
      .where(eq(serviceRuleVersions.isActive, true));
    if (activeRules?.contentHash !== config.hashes.services) {
      const [existing] = await tx
        .select({ id: serviceRuleVersions.id, contentHash: serviceRuleVersions.contentHash })
        .from(serviceRuleVersions)
        .where(eq(serviceRuleVersions.version, config.registry.version));
      if (existing && existing.contentHash !== config.hashes.services) {
        throw new ConfigError(
          `Service rules version "${config.registry.version}" already exists with different content. ` +
            `Bump the version in services.json instead of editing it in place.`,
        );
      }
      if (activeRules) {
        await tx.update(serviceRuleVersions).set({ isActive: false }).where(eq(serviceRuleVersions.id, activeRules.id));
      }
      if (existing) {
        // Same version and content already stored (e.g. after a rollback): re-activate it.
        await tx.update(serviceRuleVersions).set({ isActive: true }).where(eq(serviceRuleVersions.id, existing.id));
        await recordAudit(tx, {
          eventType: "CONFIG_CHANGED",
          actor,
          entityType: "service_rule_versions",
          entityId: existing.id,
          data: { version: config.registry.version, previous: activeRules?.version ?? null, reactivated: true },
        });
        summary.serviceRules = "created";
      }
    }
    if (activeRules?.contentHash !== config.hashes.services && summary.serviceRules !== "created") {
      const [row] = await tx
        .insert(serviceRuleVersions)
        .values({
          version: config.registry.version,
          rules: config.registry.ruleSet,
          contentHash: config.hashes.services,
          isActive: true,
          changeNote: "synced from config files",
        })
        .returning({ id: serviceRuleVersions.id });
      await recordAudit(tx, {
        eventType: "CONFIG_CHANGED",
        actor,
        entityType: "service_rule_versions",
        entityId: row!.id,
        data: { version: config.registry.version, previous: activeRules?.version ?? null },
      });
      summary.serviceRules = "created";
    }

    // Thresholds
    const [activeThresholds] = await tx
      .select()
      .from(thresholdVersions)
      .where(eq(thresholdVersions.isActive, true));
    if (activeThresholds?.contentHash !== config.hashes.thresholds) {
      const [existing] = await tx
        .select({ id: thresholdVersions.id, contentHash: thresholdVersions.contentHash })
        .from(thresholdVersions)
        .where(eq(thresholdVersions.version, config.thresholds.version));
      if (existing && existing.contentHash !== config.hashes.thresholds) {
        throw new ConfigError(
          `Thresholds version "${config.thresholds.version}" already exists with different content. Bump the version.`,
        );
      }
      if (activeThresholds) {
        await tx.update(thresholdVersions).set({ isActive: false }).where(eq(thresholdVersions.id, activeThresholds.id));
      }
      if (existing) {
        // Same version and content already stored (e.g. after a rollback): re-activate it.
        await tx.update(thresholdVersions).set({ isActive: true }).where(eq(thresholdVersions.id, existing.id));
        await recordAudit(tx, {
          eventType: "CONFIG_CHANGED",
          actor,
          entityType: "threshold_versions",
          entityId: existing.id,
          data: { version: config.thresholds.version, previous: activeThresholds?.version ?? null, reactivated: true },
        });
        summary.thresholds = "created";
      }
    }
    if (activeThresholds?.contentHash !== config.hashes.thresholds && summary.thresholds !== "created") {
      const [row] = await tx
        .insert(thresholdVersions)
        .values({
          version: config.thresholds.version,
          thresholds: config.thresholds,
          contentHash: config.hashes.thresholds,
          provisional: config.thresholds.provisional,
          isActive: true,
          changeNote: "synced from config files",
        })
        .returning({ id: thresholdVersions.id });
      await recordAudit(tx, {
        eventType: "CONFIG_CHANGED",
        actor,
        entityType: "threshold_versions",
        entityId: row!.id,
        data: { version: config.thresholds.version, provisional: config.thresholds.provisional },
      });
      summary.thresholds = "created";
    }

    // Clients + client profiles
    for (const [code, profile] of config.clientProfiles) {
      const hash = config.hashes.clientProfiles.get(code)!;
      const [client] = await tx
        .insert(clients)
        .values({ code, displayName: profile.display_name })
        .onConflictDoUpdate({ target: clients.code, set: { displayName: profile.display_name } })
        .returning({ id: clients.id });
      const clientId = client!.id;

      const [active] = await tx
        .select()
        .from(clientProfiles)
        .where(and(eq(clientProfiles.clientId, clientId), eq(clientProfiles.isActive, true)));
      if (active?.contentHash === hash) {
        summary.clientProfiles[code] = "unchanged";
        continue;
      }
      const [{ maxVersion } = { maxVersion: 0 }] = await tx
        .select({ maxVersion: max(clientProfiles.version) })
        .from(clientProfiles)
        .where(eq(clientProfiles.clientId, clientId));
      if (active) {
        await tx.update(clientProfiles).set({ isActive: false }).where(eq(clientProfiles.id, active.id));
      }
      const version = (maxVersion ?? 0) + 1;
      const [row] = await tx
        .insert(clientProfiles)
        .values({ clientId, version, profile, contentHash: hash, isActive: true, changeNote: "synced from config files" })
        .returning({ id: clientProfiles.id });
      await recordAudit(tx, {
        eventType: "CONFIG_CHANGED",
        actor,
        entityType: "client_profiles",
        entityId: row!.id,
        data: { client: code, version, previousVersion: active?.version ?? null },
      });
      summary.clientProfiles[code] = "created";
    }

    return summary;
  });
}

export interface ActiveConfig {
  registry: ServiceRegistry;
  serviceRuleVersionId: string;
  thresholds: Thresholds;
  thresholdVersionId: string;
  /** Keyed by client code. */
  clientProfiles: Map<string, { id: string; clientId: string; version: number; profile: ClientProfile }>;
}

/** Load the active configuration versions from the database (re-validated on read). */
export async function loadActiveConfig(db: Db): Promise<ActiveConfig> {
  const [rules] = await db.select().from(serviceRuleVersions).where(eq(serviceRuleVersions.isActive, true));
  const [thr] = await db.select().from(thresholdVersions).where(eq(thresholdVersions.isActive, true));
  if (!rules || !thr) {
    throw new ConfigError("No active service rules / thresholds in database. Run `npm run db:seed`.");
  }
  const parsedRules = serviceRuleSetSchema.safeParse(rules.rules);
  const parsedThresholds = thresholdsSchema.safeParse(thr.thresholds);
  if (!parsedRules.success || !parsedThresholds.success) {
    const which = !parsedRules.success ? `service rules "${rules.version}"` : `thresholds "${thr.version}"`;
    throw new ConfigError(
      `The active ${which} stored in the database are outdated for this version of the application. ` +
        "Run `npm run db:seed` to load the current config/ files as new versions.",
    );
  }
  const registry = new ServiceRegistry(parsedRules.data);
  const thresholds = parsedThresholds.data;

  const rows = await db
    .select({
      id: clientProfiles.id,
      clientId: clientProfiles.clientId,
      version: clientProfiles.version,
      profile: clientProfiles.profile,
      code: clients.code,
    })
    .from(clientProfiles)
    .innerJoin(clients, eq(clients.id, clientProfiles.clientId))
    .where(eq(clientProfiles.isActive, true));

  const profiles: ActiveConfig["clientProfiles"] = new Map();
  for (const r of rows) {
    const profile = clientProfileSchema.parse(r.profile);
    const problems = validateClientProfileAgainstRegistry(profile, registry);
    if (problems.length > 0) throw new ConfigError(problems.join("; "));
    profiles.set(r.code, { id: r.id, clientId: r.clientId, version: r.version, profile });
  }

  return {
    registry,
    serviceRuleVersionId: rules.id,
    thresholds,
    thresholdVersionId: thr.id,
    clientProfiles: profiles,
  };
}
