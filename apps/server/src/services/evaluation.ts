import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { GoldenCaseTag } from "@alvip/shared";
import { recordAudit, type Actor } from "../audit/audit";
import { loadActiveConfig } from "../config/configStore";
import type { Env } from "../config/env";
import { openDb, type Db } from "../db/client";
import {
  clientProfiles,
  clients,
  evaluationResults,
  evaluationRuns,
  goldenExampleImages,
  goldenExamples,
  imageAnalysis,
  locations,
  processingRuns,
  serviceAssessments,
  serviceRuleVersions,
  services,
  thresholdVersions,
  verificationJobs,
} from "../db/schema";
import { expectedForLocation, outcomeOf, predictFromRecommendation, predictFromStatus, summarize, type ScoredRow } from "../domain/evaluation";
import { createIntegrations, type Integrations } from "../integrations";
import { ImageFetchError, type FetchedImage, type ImageProvider } from "../integrations/images/ImageProvider";
import {
  IntegrationError,
  type NetSuiteAdapter,
  type NetSuiteImageRef,
  type NetSuiteLocation,
  type NetSuiteQueueItem,
  type WriteAck,
} from "../integrations/netsuite/NetSuiteAdapter";
import { PgQueue } from "../integrations/queue/PgQueue";
import type { QueueProvider } from "../integrations/queue/QueueProvider";
import { MemoryStorageProvider } from "../integrations/storage/LocalStorageProvider";
import type { StorageProvider } from "../integrations/storage/StorageProvider";
import type { JobHandler, Logger } from "../pipeline/jobHandler";
import { JOB_TYPES, type EvaluationRunPayload } from "../pipeline/jobTypes";
import { createWorker, registerEvaluationHandler } from "../runtime";
import { ingestQueue } from "./ingest";

/**
 * Evaluation runner (PRD §56): scores the AI pipeline against APPROVED golden examples.
 *
 * Fidelity and isolation: each run executes the exact production pipeline (same stages,
 * same active rules/thresholds/client profiles, same vision provider) inside a throwaway
 * in-memory database. The live queue, locations, dashboard and NetSuite are never touched.
 * Results are written to the main database, append-only.
 *
 * The vision cache starts empty in the sandbox, so every run measures the model afresh.
 */

export class EvaluationError extends Error {
  override name = "EvaluationError";
  constructor(
    message: string,
    readonly code: "NO_EXAMPLES" | "BUSY" | "COST_NOT_ACKNOWLEDGED" | "NOT_FOUND",
  ) {
    super(message);
  }
}

export interface EvaluationOptions {
  label?: string;
  includeDemo?: boolean;
  clientId?: string;
  tags?: GoldenCaseTag[];
  /** Try a different model for this run only (admins). Production is unchanged. */
  visionModel?: string;
}

const RUN_DEADLINE_MS = 2 * 60 * 60 * 1000;

async function selectExamples(db: Db, o: EvaluationOptions) {
  const rows = await db
    .select()
    .from(goldenExamples)
    .where(and(eq(goldenExamples.status, "APPROVED"), ...(o.clientId ? [eq(goldenExamples.clientId, o.clientId)] : [])))
    .orderBy(asc(goldenExamples.createdAt));
  return rows.filter((e) => (o.includeDemo || e.source !== "DEMO") && (!o.tags?.length || (e.tags as string[]).some((t) => o.tags!.includes(t as GoldenCaseTag))));
}

function visionFor(env: Env, integrations: Integrations, model?: string) {
  return model ? createIntegrations({ ...env, VISION_MODEL: model }).vision : integrations.vision;
}

export async function requestEvaluation(db: Db, queue: QueueProvider, env: Env, integrations: Integrations, actor: Actor & { type: "USER" }, o: EvaluationOptions & { acknowledgeCost?: boolean }) {
  const [busy] = await db.select({ id: evaluationRuns.id }).from(evaluationRuns).where(inArray(evaluationRuns.status, ["PENDING", "RUNNING"])).limit(1);
  if (busy) throw new EvaluationError("An evaluation is already running. Wait for it to finish.", "BUSY");
  const examples = await selectExamples(db, o);
  if (examples.length === 0) throw new EvaluationError("No approved examples match. Add and approve examples first.", "NO_EXAMPLES");
  const vision = visionFor(env, integrations, o.visionModel);
  if (vision.info.external && !o.acknowledgeCost) {
    throw new EvaluationError(`This run sends the examples' photos to ${vision.info.provider} (${vision.info.model}) and is billed. Confirm to continue.`, "COST_NOT_ACKNOWLEDGED");
  }
  return db.transaction(async (tx) => {
    const options = { includeDemo: !!o.includeDemo, ...(o.clientId ? { clientId: o.clientId } : {}), ...(o.tags?.length ? { tags: o.tags } : {}), ...(o.visionModel ? { visionModel: o.visionModel } : {}) };
    const [run] = await tx.insert(evaluationRuns).values({ label: o.label?.trim() || null, requestedBy: actor.id, options, exampleCount: examples.length }).returning();
    await queue.enqueue({ type: JOB_TYPES.EVALUATION_RUN, payload: { evaluationRunId: run!.id } satisfies EvaluationRunPayload, idempotencyKey: `evaluation:${run!.id}`, maxAttempts: 1 }, tx);
    await recordAudit(tx, { eventType: "EVALUATION_REQUESTED", actor, entityType: "evaluation_runs", entityId: run!.id, data: { ...options, examples: examples.length } });
    return run!;
  });
}

type Example = Awaited<ReturnType<typeof selectExamples>>[number];
type ExampleImage = typeof goldenExampleImages.$inferSelect;

/** Serves golden examples to the pipeline as if they were NetSuite work items. Read-only. */
class GoldenNetSuiteAdapter implements NetSuiteAdapter {
  readonly name = "golden-dataset";
  constructor(
    private readonly examples: Example[],
    private readonly imagesByExample: Map<string, ExampleImage[]>,
    private readonly clientCodes: Map<string, string>,
  ) {}
  private find(id: string) {
    const e = this.examples.find((x) => x.id === id);
    if (!e) throw new IntegrationError(`Golden example ${id} not found`, "NETSUITE_VALIDATION");
    return e;
  }
  async getQueue(): Promise<NetSuiteQueueItem[]> {
    const now = Date.now();
    return this.examples.map((e, i) => ({ externalId: e.id, clientCode: this.clientCodes.get(e.clientId)!, receivedAt: new Date(now - (this.examples.length - i) * 1000) }));
  }
  async getLocation(externalId: string): Promise<NetSuiteLocation> {
    const e = this.find(externalId);
    return { externalId, clientCode: this.clientCodes.get(e.clientId)!, name: e.title, existingVerificationStatus: null };
  }
  async getRequiredServices(externalId: string): Promise<string[]> {
    return [...(this.find(externalId).services as string[])];
  }
  async getImages(externalId: string): Promise<NetSuiteImageRef[]> {
    return (this.imagesByExample.get(externalId) ?? []).map((i) => ({
      externalRef: i.externalRef,
      ordinal: i.ordinal,
      ...(i.filename ? { filename: i.filename } : {}),
      ...(i.capturedAt ? { capturedAt: i.capturedAt } : {}),
      locator: `golden://${i.id}`,
    }));
  }
  async updateVerification(): Promise<WriteAck> {
    throw new IntegrationError("Evaluation never writes to NetSuite", "CONFIGURATION");
  }
  async addVerificationNote(): Promise<WriteAck> {
    throw new IntegrationError("Evaluation never writes to NetSuite", "CONFIGURATION");
  }
}

class GoldenImageProvider implements ImageProvider {
  readonly name = "golden-dataset";
  constructor(
    private readonly keys: Map<string, { key: string; contentType: string | null }>,
    private readonly storage: StorageProvider,
  ) {}
  async fetch(locator: string): Promise<FetchedImage> {
    const entry = this.keys.get(locator.replace(/^golden:\/\//, ""));
    const bytes = entry ? await this.storage.get(entry.key) : null;
    if (!bytes) throw new ImageFetchError(`Golden photo ${locator} is missing from storage`, "NOT_FOUND");
    return { bytes, ...(entry!.contentType ? { contentType: entry!.contentType } : {}) };
  }
}

/** Copy the active configuration rows into the sandbox, ids included. */
async function copyConfig(main: Db, sandbox: Db) {
  const copy = async <T extends Record<string, unknown>>(rows: T[], insert: (rows: T[]) => Promise<unknown>) => {
    if (rows.length) await insert(rows);
  };
  await copy(await main.select().from(services), (r) => sandbox.insert(services).values(r));
  await copy(await main.select().from(serviceRuleVersions).where(eq(serviceRuleVersions.isActive, true)), (r) => sandbox.insert(serviceRuleVersions).values(r));
  await copy(await main.select().from(thresholdVersions).where(eq(thresholdVersions.isActive, true)), (r) => sandbox.insert(thresholdVersions).values(r));
  await copy(await main.select().from(clients), (r) => sandbox.insert(clients).values(r));
  await copy(await main.select().from(clientProfiles).where(eq(clientProfiles.isActive, true)), (r) => sandbox.insert(clientProfiles).values(r));
}

export interface EvaluationDeps {
  db: Db;
  env: Env;
  integrations: Integrations;
  log: Logger;
  heartbeat: () => Promise<void>;
}

export async function executeEvaluation(deps: EvaluationDeps, runId: string, actor: Actor) {
  const { db, env } = deps;
  const [run] = await db.select().from(evaluationRuns).where(eq(evaluationRuns.id, runId));
  if (!run) throw new EvaluationError("Evaluation run not found", "NOT_FOUND");
  const started = Date.now();
  await db.update(evaluationRuns).set({ status: "RUNNING", startedAt: new Date() }).where(eq(evaluationRuns.id, runId));

  const o = run.options as EvaluationOptions;
  const examples = await selectExamples(db, o);
  if (examples.length === 0) throw new EvaluationError("No approved examples match any more", "NO_EXAMPLES");
  const config = await loadActiveConfig(db);
  const imgs = await db
    .select()
    .from(goldenExampleImages)
    .where(inArray(goldenExampleImages.exampleId, examples.map((e) => e.id)))
    .orderBy(asc(goldenExampleImages.ordinal));
  const imagesByExample = new Map<string, ExampleImage[]>();
  for (const i of imgs) imagesByExample.set(i.exampleId, [...(imagesByExample.get(i.exampleId) ?? []), i]);
  const clientRows = await db.select({ id: clients.id, code: clients.code, name: clients.displayName }).from(clients);
  const clientCodes = new Map(clientRows.map((c) => [c.id, c.code]));
  const clientNames = new Map(clientRows.map((c) => [c.id, c.name]));

  const vision = visionFor(env, deps.integrations, o.visionModel);
  const sandbox = await openDb({ pgliteDataDir: "memory://" });
  try {
    await sandbox.migrate();
    await copyConfig(db, sandbox.db);
    const integrations: Integrations = {
      netsuite: new GoldenNetSuiteAdapter(examples, imagesByExample, clientCodes),
      images: new GoldenImageProvider(new Map(imgs.map((i) => [i.id, { key: i.storageKey, contentType: i.contentType }])), deps.integrations.storage),
      storage: new MemoryStorageProvider(),
      vision,
    };
    const sandboxEnv: Env = { ...env, AUTOMATION_LEVEL: Math.max(1, env.AUTOMATION_LEVEL) as Env["AUTOMATION_LEVEL"], NETSUITE_POLL_INTERVAL_SEC: 0, RETENTION_SWEEP_INTERVAL_SEC: 0, NETSUITE_SYNC_SWEEP_INTERVAL_SEC: 0 };
    const queue = new PgQueue(sandbox.db, { baseMs: 1000, capMs: 15_000 });
    const worker = createWorker(sandboxEnv, sandbox.db, { queue, integrations }, deps.log, { pollNetSuite: false, evaluation: false });
    await ingestQueue({ db: sandbox.db, netsuite: integrations.netsuite, queue, actor: { type: "SYSTEM", id: "evaluation" } });

    // Process every example (transient errors are retried with short backoff).
    while (Date.now() - started < RUN_DEADLINE_MS) {
      const n = await worker.runOnce();
      await deps.heartbeat();
      const [open] = await sandbox.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(verificationJobs).where(inArray(verificationJobs.status, ["PENDING", "RUNNING"]));
      if (!open || open.n === 0) break;
      if (n === 0) await new Promise((r) => setTimeout(r, 250));
    }

    // ---- score
    const scored: ScoredRow[] = [];
    const resultRows: (typeof evaluationResults.$inferInsert)[] = [];
    const sLocs = await sandbox.db.select().from(locations);
    let promptVersion: string | null = null;
    let model: string | null = null;
    let provider: string | null = null;
    let costUsd = 0;
    for (const ex of examples) {
      const loc = sLocs.find((l) => l.externalId === ex.id);
      const runRow = loc?.currentRunId ? (await sandbox.db.select().from(processingRuns).where(eq(processingRuns.id, loc.currentRunId)))[0] : undefined;
      if (runRow) {
        promptVersion ??= runRow.promptVersion;
        model ??= runRow.visionModel;
        provider ??= runRow.visionProvider;
      }
      for (const r of loc ? await sandbox.db.select({ cost: processingRuns.aiCostUsd }).from(processingRuns).where(eq(processingRuns.locationId, loc.id)) : []) costUsd += Number(r.cost ?? 0);
      const assessments = runRow ? await sandbox.db.select().from(serviceAssessments).where(eq(serviceAssessments.runId, runRow.id)) : [];
      const analysis = runRow ? await sandbox.db.select({ usable: imageAnalysis.usable }).from(imageAnalysis).where(eq(imageAnalysis.runId, runRow.id)) : [];
      const failed = !loc || loc.status !== "HUMAN_REVIEW" || assessments.length === 0;
      const quality = analysis.some((a) => a.usable === false) ? "POOR" : "GOOD";
      const expected = ex.expected as Record<string, "APPROVE" | "REJECT">;
      const base = { exampleId: ex.id, clientName: clientNames.get(ex.clientId) ?? "?", tags: ex.tags as string[], imageQuality: quality as "GOOD" | "POOR", reviewerDecision: ex.reviewerDecision };
      for (const svc of ex.services as string[]) {
        const a = assessments.find((x) => x.serviceCode === svc);
        const predicted = predictFromStatus(a?.status);
        const outcome = outcomeOf(expected[svc]!, predicted, failed);
        scored.push({ ...base, serviceCode: svc, expected: expected[svc]!, predicted, outcome, aiConfidence: a?.confidenceLevel ?? null });
        resultRows.push({
          runId,
          exampleId: ex.id,
          serviceCode: svc,
          expected: expected[svc]!,
          aiStatus: a?.status ?? null,
          aiConfidence: a?.confidenceLevel ?? null,
          predicted,
          outcome,
          explanation: failed ? `Processing did not complete (${loc?.status ?? "not created"})` : (a?.explanation ?? null),
        });
      }
      const locExpected = expectedForLocation(expected);
      const locPredicted = predictFromRecommendation(loc?.aiRecommendation);
      const locOutcome = outcomeOf(locExpected, locPredicted, failed);
      scored.push({ ...base, serviceCode: null, expected: locExpected, predicted: locPredicted, outcome: locOutcome, aiConfidence: null });
      resultRows.push({ runId, exampleId: ex.id, serviceCode: null, expected: locExpected, aiStatus: loc?.aiRecommendation ?? loc?.status ?? null, aiConfidence: null, predicted: locPredicted, outcome: locOutcome, explanation: null });
    }

    const summary = {
      ...summarize(scored, config.thresholds.metrics.min_sample_size),
      examples: examples.length,
      demoExamples: examples.filter((e) => e.source === "DEMO").length,
      durationMs: Date.now() - started,
      minSample: config.thresholds.metrics.min_sample_size,
    };
    const versions = {
      visionProvider: provider ?? vision.info.provider,
      visionModel: model ?? vision.info.model,
      promptVersion,
      serviceRuleVersionId: config.serviceRuleVersionId,
      serviceRuleVersion: config.registry.version,
      thresholdVersionId: config.thresholdVersionId,
      thresholdsVersion: config.thresholds.version,
      automationLevel: sandboxEnv.AUTOMATION_LEVEL,
      applicationVersion: process.env.npm_package_version ?? "dev",
    };
    await db.transaction(async (tx) => {
      if (resultRows.length) await tx.insert(evaluationResults).values(resultRows);
      await tx.update(evaluationRuns).set({ status: "SUCCEEDED", completedAt: new Date(), summary, versions, costUsd: costUsd.toFixed(6), exampleCount: examples.length }).where(eq(evaluationRuns.id, runId));
      await recordAudit(tx, {
        eventType: "EVALUATION_COMPLETED",
        actor,
        entityType: "evaluation_runs",
        entityId: runId,
        data: { examples: examples.length, falseApprovals: summary.overall.falseApprovals, costUsd, versions },
      });
    });
    return summary;
  } finally {
    await sandbox.close();
  }
}

export const evaluationRunHandler: JobHandler = {
  type: JOB_TYPES.EVALUATION_RUN,
  async handle(job, ctx) {
    const { evaluationRunId } = job.payload as unknown as EvaluationRunPayload;
    await executeEvaluation({ db: ctx.db, env: ctx.env, integrations: ctx.integrations, log: ctx.log, heartbeat: ctx.heartbeat }, evaluationRunId, { type: "WORKER", id: ctx.workerId });
  },
  async onFailure(job, error, _outcome, ctx) {
    const { evaluationRunId } = job.payload as unknown as EvaluationRunPayload;
    await ctx.db.update(evaluationRuns).set({ status: "FAILED", completedAt: new Date(), error: error.message.slice(0, 2000) }).where(eq(evaluationRuns.id, evaluationRunId));
  },
};

export async function listEvaluationRuns(db: Db) {
  return db
    .select({
      id: evaluationRuns.id,
      label: evaluationRuns.label,
      status: evaluationRuns.status,
      requestedAt: evaluationRuns.requestedAt,
      completedAt: evaluationRuns.completedAt,
      exampleCount: evaluationRuns.exampleCount,
      versions: evaluationRuns.versions,
      options: evaluationRuns.options,
      costUsd: evaluationRuns.costUsd,
      error: evaluationRuns.error,
      overall: sql<unknown>`${evaluationRuns.summary}->'overall'`,
      location: sql<unknown>`${evaluationRuns.summary}->'location'`,
      demoExamples: sql<number | null>`(${evaluationRuns.summary}->>'demoExamples')::int`,
    })
    .from(evaluationRuns)
    .orderBy(desc(evaluationRuns.requestedAt))
    .limit(100);
}

export async function getEvaluationRun(db: Db, id: string) {
  const [run] = await db.select().from(evaluationRuns).where(eq(evaluationRuns.id, id));
  if (!run) throw new EvaluationError("Evaluation run not found", "NOT_FOUND");
  const results = await db
    .select({
      exampleId: evaluationResults.exampleId,
      title: goldenExamples.title,
      serviceCode: evaluationResults.serviceCode,
      expected: evaluationResults.expected,
      aiStatus: evaluationResults.aiStatus,
      aiConfidence: evaluationResults.aiConfidence,
      predicted: evaluationResults.predicted,
      outcome: evaluationResults.outcome,
      explanation: evaluationResults.explanation,
    })
    .from(evaluationResults)
    .innerJoin(goldenExamples, eq(goldenExamples.id, evaluationResults.exampleId))
    .where(eq(evaluationResults.runId, id))
    .orderBy(asc(goldenExamples.title), asc(evaluationResults.serviceCode));
  return { run, results };
}

registerEvaluationHandler(evaluationRunHandler);
