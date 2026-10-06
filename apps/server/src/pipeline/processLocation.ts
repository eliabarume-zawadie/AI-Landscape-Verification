import { and, count, eq, max, sql } from "drizzle-orm";
import { recordAudit, type Actor } from "../audit/audit";
import { loadActiveConfig, type ActiveConfig } from "../config/configStore";
import { clients, images, locations, locationServices, processingRuns } from "../db/schema";
import { IN_PROGRESS_STATUSES } from "../domain/locationState";
import type { Db } from "../db/client";
import { WorkItemError } from "../services/errors";
import { reachableErrorStatus, transitionLocation } from "../services/locationTransitions";
import type { JobContext, JobHandler } from "./jobHandler";
import { JOB_TYPES, type ProcessLocationPayload } from "./jobTypes";
import { runImageStage } from "./stages/imageStage";
import type { AiRecommendation, Lane, RiskLevel } from "@alvip/shared";
import { runBundleStage } from "./stages/bundleStage";
import { runRiskStage } from "./stages/riskStage";
import { levelFor, rolloutFor, type EffectiveRollout } from "../services/rollout";
import { runEvidenceStage, servicesToObserve } from "./stages/evidenceStage";
import { runPairStage } from "./stages/pairStage";
import { runVisionStage } from "./stages/visionStage";

/**
 * PROCESS_LOCATION: one processing run for one location (PRD §12, §40).
 *
 * Stages so far: crash recovery, versioned run creation, image reference acquisition,
 * image bytes + format/quality + duplicate clustering (Phase 3), AI vision observations
 * (Phase 4), then routing to human review. Evidence, pairing, and risk stages are added
 * in Phases 5–8. Until then no AI analysis is
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
    // Rollout (Phase 15): this client's mode decides whether the AI runs, hidden or visible.
    const rollout = await rolloutFor(db, ctx.env, loc.clientId);
    const runId = await startRun(ctx, config, loc, payload, actor, rollout);

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

    // ---- Automation level 0: manual verification, no AI analysis.
    if (!rollout.aiEnabled) {
      await finishRun(ctx, { locationId: loc.id, runId, actor, aiAnalysisPerformed: false, reason: "AUTOMATION_LEVEL_0_MANUAL" });
      return;
    }

    // ---- Stage: AI vision observations (Phase 4)
    await transitionLocation(db, { locationId: loc.id, to: "ANALYZING", actor, runId });
    const services = (
      await db.select({ code: locationServices.serviceCode }).from(locationServices).where(eq(locationServices.locationId, loc.id))
    ).map((r) => r.code);
    const profile = config.clientProfiles.get(loc.clientCode)!.profile;
    const observe = servicesToObserve(config.registry, profile, services);
    await runVisionStage(ctx, { locationId: loc.id, runId, services: observe, config, actor });

    // ---- Stage: before/after pairing and comparison (Phase 6)
    const pairing = await runPairStage(ctx, { locationId: loc.id, runId, services: observe, config, profile, actor });
    await transitionLocation(db, { locationId: loc.id, to: "EVIDENCE_BUILDING", actor, runId });

    // ---- Stage: service evidence (Phase 5), now with before/after and area coverage.
    const assessments = await runEvidenceStage(ctx, { locationId: loc.id, runId, services, config, profile, stage: pairing.stageInputs, actor });

    // ---- Stage: evidence bundle (Phase 7)
    await runBundleStage(ctx, {
      locationId: loc.id,
      runId,
      assessments,
      pairs: pairing.pairs,
      establishedBy: pairing.establishedBy,
      thresholds: config.thresholds,
      actor,
    });

    // ---- Stage: risk, recommendation and lane (Phase 8)
    const outcome = await runRiskStage(ctx, { locationId: loc.id, runId, assessments, config, profile, actor, rollout, services });

    await finishRun(ctx, {
      locationId: loc.id,
      runId,
      actor,
      aiAnalysisPerformed: true,
      reason: "AI_ASSESSMENT_COMPLETE",
      via: ["AI_REVIEW_READY"],
      recommendation: outcome.recommendation,
      lane: outcome.lane,
      riskLevel: outcome.risk.level,
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
  rollout: EffectiveRollout,
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
        automationLevel: levelFor(rollout.mode, ctx.env),
        shadowMode: rollout.shadow,
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
        automationLevel: levelFor(rollout.mode, ctx.env),
        shadowMode: rollout.shadow,
        rolloutMode: rollout.mode,
        rolloutSource: rollout.source,
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

/**
 * Close a successful run and route the location to human review. No AI decision is
 * made: the recommendation is NEEDS_HUMAN_REVIEW until the evidence and risk engines
 * (Phases 5–8) exist, and even then final decisions stay human (PRD §27).
 */
async function finishRun(
  ctx: JobContext,
  input: {
    locationId: string;
    runId: string;
    actor: Actor;
    aiAnalysisPerformed: boolean;
    reason: string;
    via?: ("AI_REVIEW_READY")[];
    recommendation?: AiRecommendation;
    lane?: Lane;
    riskLevel?: RiskLevel;
  },
): Promise<void> {
  const recommendation = input.recommendation ?? "NEEDS_HUMAN_REVIEW";
  const lane = input.lane ?? "HUMAN_REVIEW";
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(processingRuns)
      .set({ status: "SUCCEEDED", completedAt: sql`now()`, aiRecommendation: recommendation, lane })
      .where(eq(processingRuns.id, input.runId));
    await tx
      .update(locations)
      .set({ aiRecommendation: input.aiAnalysisPerformed ? recommendation : null, riskLevel: input.riskLevel ?? null })
      .where(eq(locations.id, input.locationId));
    await recordAudit(tx, {
      eventType: "ANALYSIS_COMPLETED",
      actor: input.actor,
      locationId: input.locationId,
      runId: input.runId,
      data: { aiAnalysisPerformed: input.aiAnalysisPerformed, reason: input.reason, recommendation, lane, riskLevel: input.riskLevel ?? null },
    });
    for (const step of input.via ?? []) {
      await transitionLocation(tx, { locationId: input.locationId, to: step, actor: input.actor, runId: input.runId });
    }
    await transitionLocation(tx, {
      locationId: input.locationId,
      to: "HUMAN_REVIEW",
      actor: input.actor,
      runId: input.runId,
      lane,
      reason: input.reason,
    });
  });
}
