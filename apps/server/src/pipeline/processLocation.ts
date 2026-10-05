import { and, count, eq, max, sql } from "drizzle-orm";
import { recordAudit, type Actor } from "../audit/audit";
import { loadActiveConfig, type ActiveConfig } from "../config/configStore";
import { clients, images, locations, processingRuns } from "../db/schema";
import { IN_PROGRESS_STATUSES } from "../domain/locationState";
import type { Db } from "../db/client";
import { WorkItemError } from "../services/errors";
import { reachableErrorStatus, transitionLocation } from "../services/locationTransitions";
import type { JobContext, JobHandler } from "./jobHandler";
import { JOB_TYPES, type ProcessLocationPayload } from "./jobTypes";
import { runImageStage } from "./stages/imageStage";

/**
 * PROCESS_LOCATION: one processing run for one location (PRD §12, §40).
 *
 * Stages so far: crash recovery, versioned run creation, image reference acquisition,
 * image bytes + format/quality + duplicate clustering (Phase 3), then routing to human
 * review. AI stages (vision, pairing, evidence, risk) are added in Phases 4–8. Until then no AI analysis is
 * claimed: the run records `aiAnalysisPerformed: false` and the location goes to
 * HUMAN_REVIEW with recommendation NEEDS_HUMAN_REVIEW.
 */
export const processLocationHandler: JobHandler = {
  type: JOB_TYPES.PROCESS_LOCATION,

  async handle(job, ctx) {
    const payload = job.payload as unknown as ProcessLocationPayload;
    const actor: Actor = { type: "WORKER", id: ctx.workerId };
    const { db } = ctx;

    const loc = await loadLocation(db, payload.locationId);
    if (IN_PROGRESS_STATUSES.includes(loc.status)) {
      // A previous attempt was interrupted (crash / lease expiry). Close it out and restart.
      await failRunningRuns(db, loc.id, "interrupted: processing restarted");
      await transitionLocation(db, {
        locationId: loc.id,
        to: "QUEUED",
        actor,
        reason: "recovered interrupted processing",
      });
    } else if (loc.status !== "QUEUED") {
      ctx.log.info({ locationId: loc.id, status: loc.status, jobId: job.id }, "location not queued; skipping job");
      return;
    }

    const config = await loadActiveConfig(db);
    const runId = await startRun(ctx, config, loc, payload, actor);

    // ---- Stage: acquire image references
    const refs = await ctx.integrations.netsuite.getImages(loc.externalId);
    if (refs.length === 0) {
      throw new WorkItemError("No images were submitted for this location", "INVALID_IMAGE", "IMAGE_ERROR");
    }
    const inserted = await db
      .insert(images)
      .values(
        refs.map((r) => ({
          locationId: loc.id,
          externalRef: r.externalRef,
          locator: r.locator,
          filename: r.filename ?? null,
          ordinal: r.ordinal ?? null,
          capturedAt: r.capturedAt ?? null,
        })),
      )
      .onConflictDoNothing({ target: [images.locationId, images.externalRef] })
      .returning({ id: images.id });
    const [{ total } = { total: 0 }] = await db
      .select({ total: count() })
      .from(images)
      .where(eq(images.locationId, loc.id));
    await db.update(processingRuns).set({ imageCount: total }).where(eq(processingRuns.id, runId));
    await ctx.heartbeat();

    // ---- Stage: fetch bytes, format/quality, duplicates (Phase 3)
    const imageSummary = await runImageStage(ctx, { locationId: loc.id, runId, thresholds: config.thresholds, actor });
    await recordAudit(db, {
      eventType: "IMAGES_DOWNLOADED",
      actor,
      locationId: loc.id,
      runId,
      data: {
        listed: refs.length,
        newImages: inserted.length,
        totalImages: total,
        fetched: imageSummary.fetched,
        reusedFromStorage: imageSummary.reused,
        missing: imageSummary.missing,
      },
    });
    await ctx.heartbeat();

    // ---- Stages 4–8 (vision, pairing, evidence, risk) plug in here.

    // ---- Route to human review. No AI decision is made in this phase.
    const reason = ctx.env.AUTOMATION_LEVEL === 0 ? "AUTOMATION_LEVEL_0_MANUAL" : "AI_STAGES_NOT_YET_AVAILABLE";
    await db.transaction(async (tx) => {
      await tx
        .update(processingRuns)
        .set({
          status: "SUCCEEDED",
          completedAt: sql`now()`,
          aiRecommendation: "NEEDS_HUMAN_REVIEW",
          lane: "HUMAN_REVIEW",
        })
        .where(eq(processingRuns.id, runId));
      await recordAudit(tx, {
        eventType: "ANALYSIS_COMPLETED",
        actor,
        locationId: loc.id,
        runId,
        data: { aiAnalysisPerformed: false, reason, recommendation: "NEEDS_HUMAN_REVIEW" },
      });
      await transitionLocation(tx, {
        locationId: loc.id,
        to: "HUMAN_REVIEW",
        actor,
        runId,
        lane: "HUMAN_REVIEW",
        reason,
      });
    });
  },

  async onFailure(job, error, outcome, ctx) {
    const payload = job.payload as unknown as ProcessLocationPayload;
    const actor: Actor = { type: "WORKER", id: ctx.workerId };
    const loc = await loadLocation(ctx.db, payload.locationId).catch(() => null);
    if (!loc) return;

    await failRunningRuns(ctx.db, loc.id, `${error.category}: ${error.message}`);

    if (outcome === "RETRY") {
      if (IN_PROGRESS_STATUSES.includes(loc.status)) {
        await transitionLocation(ctx.db, { locationId: loc.id, to: "QUEUED", actor, reason: `retry scheduled (${error.category})` });
      }
      return;
    }

    const target = reachableErrorStatus(loc.status, error.errorStatus);
    if (target) {
      await transitionLocation(ctx.db, {
        locationId: loc.id,
        to: target,
        actor,
        reason: `${error.category}: ${error.message}`,
      });
    }
  },
};

interface LoadedLocation {
  id: string;
  externalId: string;
  status: (typeof locations.$inferSelect)["status"];
  clientId: string;
  clientCode: string;
}

async function loadLocation(db: Db, locationId: string): Promise<LoadedLocation> {
  const [row] = await db
    .select({
      id: locations.id,
      externalId: locations.externalId,
      status: locations.status,
      clientId: locations.clientId,
      clientCode: clients.code,
    })
    .from(locations)
    .innerJoin(clients, eq(clients.id, locations.clientId))
    .where(eq(locations.id, locationId));
  if (!row) throw new WorkItemError(`Location ${locationId} not found`, "INTERNAL", "INTEGRATION_ERROR");
  return row;
}

/** Create the versioned processing run (PRD §40, §42) and move QUEUED → DOWNLOADING. */
async function startRun(
  ctx: JobContext,
  config: ActiveConfig,
  loc: LoadedLocation,
  payload: ProcessLocationPayload,
  actor: Actor,
): Promise<string> {
  const profile = config.clientProfiles.get(loc.clientCode);
  if (!profile) {
    throw new WorkItemError(`No active client profile for ${loc.clientCode}`, "CONFIGURATION", "INTEGRATION_ERROR");
  }

  return ctx.db.transaction(async (tx) => {
    await tx.select({ id: locations.id }).from(locations).where(eq(locations.id, loc.id)).for("update");
    const [{ last } = { last: 0 }] = await tx
      .select({ last: max(processingRuns.runNumber) })
      .from(processingRuns)
      .where(eq(processingRuns.locationId, loc.id));
    const runNumber = (last ?? 0) + 1;

    const [run] = await tx
      .insert(processingRuns)
      .values({
        locationId: loc.id,
        runNumber,
        reason: payload.reason,
        triggeredBy: payload.requestedBy ?? null,
        automationLevel: ctx.env.AUTOMATION_LEVEL,
        shadowMode: ctx.env.SHADOW_MODE,
        serviceRuleVersionId: config.serviceRuleVersionId,
        clientProfileId: profile.id,
        thresholdVersionId: config.thresholdVersionId,
        applicationVersion: ctx.env.APP_VERSION,
      })
      .returning({ id: processingRuns.id });
    const runId = run!.id;

    await tx.update(locations).set({ currentRunId: runId }).where(eq(locations.id, loc.id));
    await recordAudit(tx, {
      eventType: "ANALYSIS_STARTED",
      actor,
      locationId: loc.id,
      runId,
      data: {
        runNumber,
        reason: payload.reason,
        ...(payload.note ? { note: payload.note } : {}),
        serviceRulesVersion: config.registry.version,
        clientProfileVersion: profile.version,
        thresholdsVersion: config.thresholds.version,
        automationLevel: ctx.env.AUTOMATION_LEVEL,
        shadowMode: ctx.env.SHADOW_MODE,
        applicationVersion: ctx.env.APP_VERSION,
      },
    });
    await transitionLocation(tx, { locationId: loc.id, to: "DOWNLOADING", actor, runId });
    return runId;
  });
}

async function failRunningRuns(db: Db, locationId: string, error: string): Promise<void> {
  await db
    .update(processingRuns)
    .set({ status: "FAILED", completedAt: sql`now()`, error: error.slice(0, 2000) })
    .where(and(eq(processingRuns.locationId, locationId), eq(processingRuns.status, "RUNNING")));
}

