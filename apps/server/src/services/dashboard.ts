import { and, count, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { RiskLevel } from "@alvip/shared";
import type { Db } from "../db/client";
import {
  auditEvents,
  clients,
  humanReviews,
  imageAnalysis,
  imagePairs,
  locations,
  netsuiteSyncOutbox,
  processingRuns,
  systemErrors,
  users,
  verificationJobs,
} from "../db/schema";
import { agreementCounts, confidenceAgreement, diagnose, mean, median, percentile, rate, type ReviewFact } from "../domain/metrics";

/**
 * Team lead dashboard (PRD §4, §44, §79, §80). Read-only aggregation over the operational
 * tables for a date range in METRICS_TIMEZONE. Status, AI confidence and exception type are
 * reported as breakdowns; client, service, risk and reviewer are filters.
 */
export interface DashboardFilter {
  /** Inclusive local dates, YYYY-MM-DD. */
  from: string;
  to: string;
  clientId?: string;
  serviceCode?: string;
  risk?: RiskLevel;
  reviewerId?: string;
}

export interface DashboardOptions {
  timezone: string;
  minSample: number;
  /** Minutes a location took to verify before ALVIP (business-provided); null = not configured. */
  baselineReviewSeconds: number | null;
  now?: Date;
}

const OPEN_PRE_REVIEW = ["NEW", "QUEUED", "DOWNLOADING", "ANALYZING", "EVIDENCE_BUILDING", "AI_REVIEW_READY"] as const;
const AWAITING_REVIEW = ["HUMAN_REVIEW", "ESCALATED"] as const;
const ERROR_STATES = ["IMAGE_ERROR", "AI_ERROR", "INTEGRATION_ERROR", "NETSUITE_ERROR"] as const;
const TO_NETSUITE = ["APPROVED", "REJECTED", "SYNCING"] as const;

export function localToday(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** [from, to) instants for inclusive local dates in the given timezone. */
async function bounds(db: Db, f: DashboardFilter, tz: string): Promise<{ start: Date; end: Date }> {
  const res = (await db.execute(
    sql`select ((${f.from}::date)::timestamp at time zone ${tz}) as "start", (((${f.to}::date) + 1)::timestamp at time zone ${tz}) as "end"`,
  )) as unknown as { rows: { start: string | Date; end: string | Date }[] };
  const row = res.rows[0]!;
  return { start: new Date(row.start), end: new Date(row.end) };
}

function locationConditions(f: DashboardFilter): SQL[] {
  const c: SQL[] = [];
  if (f.clientId) c.push(eq(locations.clientId, f.clientId));
  if (f.risk) c.push(eq(locations.riskLevel, f.risk));
  if (f.serviceCode) c.push(sql`exists (select 1 from location_services ls where ls.location_id = ${locations.id} and ls.service_code = ${f.serviceCode})`);
  return c;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const minutesSince = (d: Date | string | null | undefined, now: Date) => (d ? (now.getTime() - new Date(d).getTime()) / 60_000 : null);

export async function buildDashboard(db: Db, f: DashboardFilter, o: DashboardOptions) {
  const now = o.now ?? new Date();
  const { start, end } = await bounds(db, f, o.timezone);
  const loc = locationConditions(f);
  const inPeriod = (col: Parameters<typeof gte>[0]) => [gte(col, start), lt(col, end)];
  const isToday = f.from === f.to && f.to === localToday(o.timezone, now);

  const [[received], runs, [img], [pairs], reviews, [completed], statusRows, [oldestAwaiting], [oldestUnprocessed], openErrors, recentErrors, jobs, [lastJob], outbox, [nsLatency]] =
    await Promise.all([
      db.select({ n: count() }).from(locations).where(and(...inPeriod(locations.receivedAt), ...loc)),
      db
        .select({
          locationId: processingRuns.locationId,
          status: processingRuns.status,
          startedAt: processingRuns.startedAt,
          completedAt: processingRuns.completedAt,
          imageCount: processingRuns.imageCount,
          cost: processingRuns.aiCostUsd,
          recommendation: processingRuns.aiRecommendation,
          clientId: clients.id,
          clientName: clients.displayName,
        })
        .from(processingRuns)
        .innerJoin(locations, eq(locations.id, processingRuns.locationId))
        .innerJoin(clients, eq(clients.id, locations.clientId))
        .where(and(...inPeriod(processingRuns.completedAt), ...loc)),
      db
        .select({
          total: count(),
          attempted: sql<number>`count(*) filter (where ${imageAnalysis.analysisStatus} in ('ANALYZED','CACHED','MALFORMED','REFUSED','NOT_RUN'))`.mapWith(Number),
          analyzed: sql<number>`count(*) filter (where ${imageAnalysis.analysisStatus} in ('ANALYZED','CACHED'))`.mapWith(Number),
          unusable: sql<number>`count(*) filter (where ${imageAnalysis.usable} = false)`.mapWith(Number),
          cacheHits: sql<number>`count(*) filter (where ${imageAnalysis.cacheHit} and ${imageAnalysis.analysisStatus} in ('ANALYZED','CACHED'))`.mapWith(Number),
          cost: sql<string>`coalesce(sum(${imageAnalysis.costUsd}), 0)`,
          avgLatency: sql<number | null>`avg(${imageAnalysis.latencyMs}) filter (where not ${imageAnalysis.cacheHit})`,
          p95Latency: sql<number | null>`percentile_cont(0.95) within group (order by ${imageAnalysis.latencyMs}) filter (where not ${imageAnalysis.cacheHit} and ${imageAnalysis.latencyMs} is not null)`,
        })
        .from(imageAnalysis)
        .innerJoin(processingRuns, eq(processingRuns.id, imageAnalysis.runId))
        .innerJoin(locations, eq(locations.id, processingRuns.locationId))
        .where(and(...inPeriod(processingRuns.completedAt), ...loc)),
      db
        .select({ n: count(), cost: sql<string>`coalesce(sum(${imagePairs.costUsd}), 0)` })
        .from(imagePairs)
        .innerJoin(processingRuns, eq(processingRuns.id, imagePairs.runId))
        .innerJoin(locations, eq(locations.id, processingRuns.locationId))
        .where(and(...inPeriod(processingRuns.completedAt), ...loc)),
      db
        .select({
          reviewerId: humanReviews.reviewerId,
          reviewerName: users.displayName,
          decision: humanReviews.decision,
          aiRecommendation: humanReviews.aiRecommendation,
          isOverride: humanReviews.isOverride,
          aiSnapshot: humanReviews.aiSnapshot,
          serviceDecisions: humanReviews.serviceDecisions,
          evidenceViewed: humanReviews.evidenceViewed,
          openedAt: humanReviews.openedAt,
          submittedAt: humanReviews.submittedAt,
          imageCount: processingRuns.imageCount,
        })
        .from(humanReviews)
        .innerJoin(locations, eq(locations.id, humanReviews.locationId))
        .innerJoin(users, eq(users.id, humanReviews.reviewerId))
        .leftJoin(processingRuns, eq(processingRuns.id, humanReviews.runId))
        .where(and(...inPeriod(humanReviews.submittedAt), ...loc, ...(f.reviewerId ? [eq(humanReviews.reviewerId, f.reviewerId)] : []))),
      db
        .select({ n: sql<number>`count(distinct ${auditEvents.locationId})`.mapWith(Number) })
        .from(auditEvents)
        .innerJoin(locations, eq(locations.id, auditEvents.locationId))
        .where(and(eq(auditEvents.eventType, "LOCATION_STATUS_CHANGED"), sql`${auditEvents.data}->>'to' = 'COMPLETED'`, ...inPeriod(auditEvents.occurredAt), ...loc)),
      db.select({ status: locations.status, n: count() }).from(locations).where(and(...loc)).groupBy(locations.status),
      db
        .select({ at: sql<Date | null>`min(${locations.receivedAt})` })
        .from(locations)
        .where(and(inArray(locations.status, [...AWAITING_REVIEW]), ...loc)),
      db
        .select({ at: sql<Date | null>`min(${locations.receivedAt})` })
        .from(locations)
        .where(and(inArray(locations.status, [...OPEN_PRE_REVIEW]), ...loc)),
      db
        .select({ category: systemErrors.category, n: count() })
        .from(systemErrors)
        .leftJoin(locations, eq(locations.id, systemErrors.locationId))
        .where(and(isNull(systemErrors.resolvedAt), ...loc))
        .groupBy(systemErrors.category),
      db
        .select({ category: systemErrors.category, n: count() })
        .from(systemErrors)
        .where(gte(systemErrors.occurredAt, new Date(now.getTime() - 3_600_000)))
        .groupBy(systemErrors.category),
      db.select({ status: verificationJobs.status, n: count() }).from(verificationJobs).groupBy(verificationJobs.status),
      db.select({ at: sql<Date | null>`max(${verificationJobs.completedAt})` }).from(verificationJobs),
      db
        .select({ status: netsuiteSyncOutbox.status, n: count() })
        .from(netsuiteSyncOutbox)
        .innerJoin(locations, eq(locations.id, netsuiteSyncOutbox.locationId))
        .where(and(...inPeriod(netsuiteSyncOutbox.createdAt), ...loc))
        .groupBy(netsuiteSyncOutbox.status),
      db
        .select({ avg: sql<number | null>`avg((${auditEvents.data}->>'latencyMs')::int)`, n: count() })
        .from(auditEvents)
        .innerJoin(locations, eq(locations.id, auditEvents.locationId))
        .where(and(eq(auditEvents.eventType, "NETSUITE_SYNC_SUCCEEDED"), sql`${auditEvents.data} ? 'latencyMs'`, ...inPeriod(auditEvents.occurredAt), ...loc)),
    ]);

  // ---------- queue
  const status = Object.fromEntries(statusRows.map((r) => [r.status, r.n])) as Record<string, number>;
  const sum = (keys: readonly string[]) => keys.reduce((a, k) => a + (status[k] ?? 0), 0);
  const final = reviews.filter((r) => r.decision !== "ESCALATE");
  const decidedLocations = final.length;
  const remaining = sum(OPEN_PRE_REVIEW) + sum(AWAITING_REVIEW) + sum(ERROR_STATES.filter((s) => s !== "NETSUITE_ERROR"));
  const succeededRuns = runs.filter((r) => r.status === "SUCCEEDED");
  const runSeconds = succeededRuns.filter((r) => r.completedAt).map((r) => (r.completedAt!.getTime() - r.startedAt.getTime()) / 1000);
  const runImages = succeededRuns.reduce((a, r) => a + (r.imageCount ?? 0), 0);

  // ---------- reviews
  const facts: ReviewFact[] = reviews.map((r) => ({
    decision: r.decision,
    aiRecommendation: r.aiRecommendation,
    isOverride: r.isOverride,
    aiServices: (((r.aiSnapshot ?? {}) as { services?: ReviewFact["aiServices"] }).services ?? {}) as ReviewFact["aiServices"],
    serviceDecisions: (r.serviceDecisions ?? {}) as Record<string, string>,
  }));
  const ag = agreementCounts(facts);
  const withAi = final.filter((r) => r.aiRecommendation !== null);
  const reviewSeconds = (rows: typeof reviews) =>
    rows.filter((r) => r.openedAt).map((r) => (r.submittedAt.getTime() - r.openedAt!.getTime()) / 1000).filter((s) => s >= 0 && s < 4 * 3600);
  const allSeconds = reviewSeconds(final);
  const conf = confidenceAgreement(facts);
  const viewed = final.map((r) => (Array.isArray(r.evidenceViewed) ? (r.evidenceViewed as unknown[]).length : 0));
  const withImages = final.filter((r) => (r.imageCount ?? 0) > 0);
  const notAllOpened = withImages.filter((r) => (Array.isArray(r.evidenceViewed) ? (r.evidenceViewed as unknown[]).length : 0) < r.imageCount!).length;
  const meanReview = mean(allSeconds);
  const saved = o.baselineReviewSeconds !== null && meanReview !== null ? o.baselineReviewSeconds - meanReview : null;

  const byReviewer = new Map<string, { id: string; name: string; rows: typeof reviews }>();
  for (const r of reviews) {
    const e = byReviewer.get(r.reviewerId) ?? { id: r.reviewerId, name: r.reviewerName, rows: [] };
    e.rows.push(r);
    byReviewer.set(r.reviewerId, e);
  }

  // ---------- cost
  const totalCost = runs.reduce((a, r) => a + num(r.cost), 0);
  const runLocations = new Set(runs.map((r) => r.locationId)).size;
  const byClient = new Map<string, { client: string; runs: number; locations: Set<string>; costUsd: number }>();
  for (const r of runs) {
    const e = byClient.get(r.clientId) ?? { client: r.clientName, runs: 0, locations: new Set<string>(), costUsd: 0 };
    e.runs++;
    e.locations.add(r.locationId);
    e.costUsd += num(r.cost);
    byClient.set(r.clientId, e);
  }

  // ---------- health
  const jobCounts = Object.fromEntries(jobs.map((j) => [j.status, j.n])) as Record<string, number>;
  const recent = Object.fromEntries(recentErrors.map((e) => [e.category, e.n])) as Record<string, number>;
  const outboxCounts = Object.fromEntries(outbox.map((r) => [r.status, r.n])) as Record<string, number>;
  const recommendations: Record<string, number> = {};
  for (const r of succeededRuns) if (r.recommendation) recommendations[r.recommendation] = (recommendations[r.recommendation] ?? 0) + 1;

  const diagnosis = diagnose({
    awaitingReview: sum(AWAITING_REVIEW),
    oldestAwaitingMinutes: minutesSince(oldestAwaiting?.at, now),
    inProgress: sum(OPEN_PRE_REVIEW),
    oldestUnprocessedMinutes: minutesSince(oldestUnprocessed?.at, now),
    errorsByStatus: Object.fromEntries(ERROR_STATES.map((s) => [s, status[s] ?? 0])),
    waitingForNetSuite: sum(TO_NETSUITE),
    netsuiteStopped: status.NETSUITE_ERROR ?? 0,
    pendingJobs: (jobCounts.PENDING ?? 0) + (jobCounts.RUNNING ?? 0),
    minutesSinceLastJobFinished: minutesSince(lastJob?.at, now),
    recentErrorsByCategory: recent,
    decidedToday: decidedLocations,
    remaining,
  });

  const m = o.minSample;
  return {
    period: { from: f.from, to: f.to, timezone: o.timezone, isToday, start: start.toISOString(), end: end.toISOString() },
    minSample: m,
    diagnosis,
    queue: {
      received: received?.n ?? 0,
      aiProcessed: new Set(succeededRuns.map((r) => r.locationId)).size,
      decided: decidedLocations,
      escalated: reviews.length - final.length,
      completed: completed?.n ?? 0,
      /** Open work right now (not period-bound): before review, awaiting review, problems. */
      remaining,
      awaitingReview: sum(AWAITING_REVIEW),
      inProgress: sum(OPEN_PRE_REVIEW),
      waitingForNetSuite: sum(TO_NETSUITE),
      problems: sum(ERROR_STATES),
      /** Share of the workload cleared: decided ÷ (decided + still open). Operational, not statistical. */
      clearance: rate(decidedLocations, decidedLocations + remaining, 0),
      oldestAwaitingReviewAt: oldestAwaiting?.at ?? null,
      oldestUnprocessedAt: oldestUnprocessed?.at ?? null,
      byStatus: status,
    },
    timing: {
      reviewsTimed: allSeconds.length,
      reviewSecondsMedian: median(allSeconds),
      reviewSecondsMean: meanReview,
      processingSecondsPerLocation: mean(runSeconds),
      processingSecondsPerImage: runImages ? runSeconds.reduce((a, b) => a + b, 0) / runImages : null,
    },
    ai: {
      agreement: rate(ag.agree, ag.opinions, m),
      override: rate(withAi.filter((r) => r.isOverride).length, withAi.length, m),
      deferredToHuman: rate(ag.deferred, final.length, m),
      approveSuggestionsRejected: rate(ag.approveSuggestedRejected, ag.approveSuggested, m),
      rejectSuggestionsApproved: rate(ag.rejectSuggestedApproved, ag.rejectSuggested, m),
      falseApproval: { measured: false as const, reason: "Needs checked ground truth (golden dataset, QC sampling). Not inferred from reviewer agreement." },
      falseRejection: { measured: false as const, reason: "Needs checked ground truth (golden dataset, QC sampling). Not inferred from reviewer agreement." },
      byConfidence: Object.fromEntries(Object.entries(conf).map(([band, c]) => [band, rate(c.agree, c.total, m)])),
      recommendations,
      imagesAnalyzed: rate(num(img?.analyzed), num(img?.attempted), m),
      imageQualityFailures: rate(num(img?.unusable), num(img?.total), m),
      latencyMs: { mean: img?.avgLatency === null || img?.avgLatency === undefined ? null : Number(img.avgLatency), p95: img?.p95Latency === null || img?.p95Latency === undefined ? null : Number(img.p95Latency) },
    },
    efficiency: {
      imagesPerLocation: mean(withImages.map((r) => r.imageCount!)),
      photosOpenedPerLocation: mean(viewed),
      decidedWithoutOpeningEveryPhoto: rate(notAllOpened, withImages.length, m),
      baselineReviewSeconds: o.baselineReviewSeconds,
      timeSavedSecondsPerLocation: saved,
      hoursSaved: saved !== null ? (saved * decidedLocations) / 3600 : null,
    },
    cost: {
      totalUsd: totalCost,
      visionUsd: num(img?.cost),
      beforeAfterUsd: num(pairs?.cost),
      runs: runs.length,
      perLocationUsd: runLocations ? totalCost / runLocations : null,
      perImageUsd: runImages ? totalCost / runImages : null,
      /** AI cost in the period ÷ locations decided in the period. */
      perDecidedLocationUsd: decidedLocations ? totalCost / decidedLocations : null,
      cacheHits: rate(num(img?.cacheHits), num(img?.analyzed), m),
      byClient: [...byClient.values()]
        .map((c) => ({ client: c.client, runs: c.runs, locations: c.locations.size, costUsd: c.costUsd, perLocationUsd: c.costUsd / c.locations.size }))
        .sort((a, b) => b.costUsd - a.costUsd),
    },
    netsuite: {
      sent: outboxCounts.SUCCEEDED ?? 0,
      retrying: (outboxCounts.FAILED ?? 0) + (outboxCounts.IN_FLIGHT ?? 0) + (outboxCounts.PENDING ?? 0),
      stopped: outboxCounts.DEAD ?? 0,
      meanLatencyMs: nsLatency?.avg === null || nsLatency?.avg === undefined ? null : Number(nsLatency.avg),
    },
    health: {
      jobs: jobCounts,
      lastJobFinishedAt: lastJob?.at ?? null,
      openProblems: Object.fromEntries(openErrors.map((e) => [e.category, e.n])),
      problemsLastHour: recent,
    },
    reviewers: [...byReviewer.values()]
      .map((e) => {
        const fin = e.rows.filter((r) => r.decision !== "ESCALATE");
        const ai = fin.filter((r) => r.aiRecommendation !== null);
        return {
          id: e.id,
          name: e.name,
          decisions: fin.length,
          escalations: e.rows.length - fin.length,
          medianSeconds: median(reviewSeconds(fin)),
          override: rate(ai.filter((r) => r.isOverride).length, ai.length, m),
        };
      })
      .sort((a, b) => b.decisions - a.decisions),
  };
}

export type Dashboard = Awaited<ReturnType<typeof buildDashboard>>;

export async function dashboardScopes(db: Db) {
  const [c, r] = await Promise.all([
    db.select({ id: clients.id, name: clients.displayName }).from(clients).orderBy(clients.displayName),
    db.select({ id: users.id, name: users.displayName }).from(users).where(eq(users.active, true)).orderBy(desc(users.displayName)),
  ]);
  return { clients: c, reviewers: r.reverse() };
}
