import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { recordAudit, SYSTEM_ACTOR } from "../audit/audit";
import { loadActiveConfig, syncConfigToDb } from "../config/configStore";
import { loadVerificationConfigFromDir } from "../config/verificationConfig";
import { createUser } from "../services/auth";
import { CONFIG_DIR, createTestDb } from "../test/helpers";
import type { DbHandle } from "./client";
import {
  auditEvents,
  clientProfiles,
  clients,
  humanReviews,
  locations,
  serviceRuleVersions,
  thresholdVersions,
} from "./schema";

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

describe("migrations + seed", () => {
  it("loads a valid active config from the database", async () => {
    const cfg = await loadActiveConfig(h.db);
    expect(cfg.registry.version).toBe("services-v1");
    expect(cfg.thresholds.provisional).toBe(true);
    expect(cfg.clientProfiles.get("DEMO_CLIENT_A")?.version).toBe(1);
  });

  it("is idempotent when the config is unchanged", async () => {
    const summary = await syncConfigToDb(h.db, loadVerificationConfigFromDir(CONFIG_DIR), SYSTEM_ACTOR);
    expect(summary.serviceRules).toBe("unchanged");
    expect(summary.thresholds).toBe("unchanged");
    expect(Object.values(summary.clientProfiles).every((s) => s === "unchanged")).toBe(true);
  });

  it("creates a new client-profile version (keeping the old one) when content changes", async () => {
    const config = loadVerificationConfigFromDir(CONFIG_DIR);
    const a = config.clientProfiles.get("DEMO_CLIENT_A")!;
    const changed = { ...a, always_human_review: true };
    config.clientProfiles.set("DEMO_CLIENT_A", changed);
    config.hashes.clientProfiles.set("DEMO_CLIENT_A", "changed-hash");

    const summary = await syncConfigToDb(h.db, config, SYSTEM_ACTOR);
    expect(summary.clientProfiles.DEMO_CLIENT_A).toBe("created");

    const [client] = await h.db.select().from(clients).where(eq(clients.code, "DEMO_CLIENT_A"));
    const versions = await h.db
      .select({ version: clientProfiles.version, isActive: clientProfiles.isActive })
      .from(clientProfiles)
      .where(eq(clientProfiles.clientId, client!.id))
      .orderBy(clientProfiles.version);
    expect(versions).toEqual([
      { version: 1, isActive: false },
      { version: 2, isActive: true },
    ]);

    const configEvents = await h.db
      .select()
      .from(auditEvents)
      .where(sql`${auditEvents.eventType} = 'CONFIG_CHANGED' and ${auditEvents.data}->>'client' = 'DEMO_CLIENT_A'`);
    expect(configEvents.length).toBe(2);
  });

  it("refuses to re-use a service rules version label for different content", async () => {
    const config = loadVerificationConfigFromDir(CONFIG_DIR);
    config.hashes.services = "different";
    await expect(syncConfigToDb(h.db, config, SYSTEM_ACTOR)).rejects.toThrow(/Bump the version/);
  });
});

describe("append-only guards", () => {
  it("blocks UPDATE and DELETE on audit_events", async () => {
    await recordAudit(h.db, { eventType: "ERROR", actor: SYSTEM_ACTOR, data: { probe: true } });
    await expect(h.db.update(auditEvents).set({ actorId: "tamper" })).rejects.toThrow();
    await expect(h.db.delete(auditEvents)).rejects.toThrow();
    await expect(h.db.execute(sql`truncate audit_events`)).rejects.toThrow();
  });

  it("blocks UPDATE and DELETE on human_reviews", async () => {
    const reviewer = await createUser(
      h.db,
      { email: "r1@test.local", displayName: "R1", role: "REVIEWER", password: "correct horse battery" },
      null,
    );
    const [client] = await h.db.select().from(clients).limit(1);
    const [loc] = await h.db
      .insert(locations)
      .values({ externalId: "EXT-1", clientId: client!.id, status: "HUMAN_REVIEW" })
      .returning();
    await h.db.insert(humanReviews).values({ locationId: loc!.id, reviewerId: reviewer.id, decision: "APPROVE" });

    await expect(h.db.update(humanReviews).set({ decision: "REJECT" })).rejects.toThrow();
    await expect(h.db.delete(humanReviews)).rejects.toThrow();
  });

  it("blocks editing versioned config content but allows toggling is_active", async () => {
    const [row] = await h.db.select().from(thresholdVersions).where(eq(thresholdVersions.isActive, true));
    await expect(
      h.db.update(thresholdVersions).set({ thresholds: { hacked: true } }).where(eq(thresholdVersions.id, row!.id)),
    ).rejects.toThrow();
    await expect(h.db.delete(serviceRuleVersions)).rejects.toThrow();

    await h.db.update(thresholdVersions).set({ isActive: false }).where(eq(thresholdVersions.id, row!.id));
    await h.db.update(thresholdVersions).set({ isActive: true }).where(eq(thresholdVersions.id, row!.id));
  });
});

describe("constraints", () => {
  it("enforces unique NetSuite external IDs (idempotent ingest)", async () => {
    const [client] = await h.db.select().from(clients).limit(1);
    await h.db.insert(locations).values({ externalId: "EXT-DUP", clientId: client!.id });
    await expect(h.db.insert(locations).values({ externalId: "EXT-DUP", clientId: client!.id })).rejects.toThrow();
  });

  it("allows only one active service rule set", async () => {
    await expect(
      h.db.insert(serviceRuleVersions).values({ version: "x", rules: {}, contentHash: "x", isActive: true }),
    ).rejects.toThrow();
  });
});
