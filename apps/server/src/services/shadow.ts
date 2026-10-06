import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import type { LocationStatus, Role } from "@alvip/shared";
import type { Db } from "../db/client";
import { clients, humanReviews, locations, processingRuns, users } from "../db/schema";
import { wilson } from "../domain/evaluation";
import { agreementCounts, confidenceAgreement, median, rate, type ReviewFact } from "../domain/metrics";

/**
 * Shadow mode (PRD §89, rollout stage 2): the AI analyses live locations, but its result is
 * hidden from the people deciding them and has no effect on the decision. The system
 * records AI result, human result, agreement and timing.
 *
 * A location is "in shadow" when its current processing run was made in shadow mode
 * (`processing_runs.shadow_mode`), so switching the setting never reveals or hides the AI
 * half-way through a location.
 *
 * Visibility: reviewers never see shadow AI output. Team leads and admins see it only once
 * the location is decided (to compare), never while it is still awaiting a decision.
 */
const DECIDED: readonly LocationStatus[] = ["APPROVED", "REJECTED", "SYNCING", "NETSUITE_ERROR", "SYNCED_TO_NETSUITE", "COMPLETED"];

export function aiHiddenFor(role: Role, shadow: boolean, status: LocationStatus): boolean {
  if (!shadow) return false;
  if (role === "REVIEWER") return true;
  return !DECIDED.includes(status);
}

/** SQL twin of aiHiddenFor, for list queries (needs `processing_runs` joined on the current run). */
export function aiHiddenSql(role: Role): SQL {
  const shadow = sql`coalesce(${processingRuns.shadowMode}, false)`;
  if (role === "REVIEWER") return shadow;
  return sql`(${shadow} and ${locations.status} not in (${sql.join(
    DECIDED.map((s) => sql`${s}`),
    sql`, `,
  )}))`;
}

export async function locationShadowState(db: Db, locationId: string): Promise<{ shadow: boolean; status: LocationStatus } | null> {
  const [row] = await db
    .select({ status: locations.status, shadow: processingRuns.shadowMode })
    .from(locations)
    .leftJoin(processingRuns, eq(processingRuns.id, locations.currentRunId))
    .where(eq(locations.id, locationId));
  return row ? { status: row.status, shadow: row.shadow ?? false } : null;
}

/** Audit event types whose data carries AI output. */
export const AI_AUDIT_EVENTS = new Set(["AI_VISION_COMPLETED", "BEFORE_AFTER_COMPLETED", "EVIDENCE_GENERATED", "EVIDENCE_BUNDLED", "RISK_CALCULATED", "ANALYSIS_COMPLETED"]);

// ---------------------------------------------------------------- shadow results report

export interface ShadowFilter {
  start: Date;
  end: Date;
  clientId?: string;
}

type Agreement = "AGREE" | "DISAGREE" | "AI_DEFERRED";

/** Shadow decisions in the period: what the AI would have said vs what the person decided. */
export async function shadowReport(db: Db, f: ShadowFilter, minSample: number) {
  const where: SQL[] = [eq(humanReviews.shadowMode, true), gte(humanReviews.submittedAt, f.start), lt(humanReviews.submittedAt, f.end)];
  if (f.clientId) where.push(eq(locations.clientId, f.clientId));
  const rows = await db
    .select({
      reviewId: humanReviews.id,
      locationId: humanReviews.locationId,
      externalId: locations.externalId,
      name: locations.name,
      clientName: clients.displayName,
      reviewerName: users.displayName,
      decision: humanReviews.decision,
      aiRecommendation: humanReviews.aiRecommendation,
      aiSnapshot: humanReviews.aiSnapshot,
      serviceDecisions: humanReviews.serviceDecisions,
      openedAt: humanReviews.openedAt,
      submittedAt: humanReviews.submittedAt,
      runStarted: processingRuns.startedAt,
      runCompleted: processingRuns.completedAt,
    })
    .from(humanReviews)
    .innerJoin(locations, eq(locations.id, humanReviews.locationId))
    .innerJoin(clients, eq(clients.id, locations.clientId))
    .innerJoin(users, eq(users.id, humanReviews.reviewerId))
    .leftJoin(processingRuns, eq(processingRuns.id, humanReviews.runId))
    .where(and(...where))
    .orderBy(desc(humanReviews.submittedAt));

  const facts: ReviewFact[] = rows.map((r) => ({
    decision: r.decision,
    aiRecommendation: r.aiRecommendation,
    isOverride: false,
    aiServices: (((r.aiSnapshot ?? {}) as { services?: ReviewFact["aiServices"] }).services ?? {}) as ReviewFact["aiServices"],
    serviceDecisions: (r.serviceDecisions ?? {}) as Record<string, string>,
  }));
  const ag = agreementCounts(facts);
  const items = rows.map((r, i) => {
    const ai = facts[i]!;
    const opinion = r.aiRecommendation === "RECOMMEND_APPROVE" ? "APPROVE" : r.aiRecommendation === "RECOMMEND_REJECT" ? "REJECT" : null;
    const agreement: Agreement | null = r.decision === "ESCALATE" ? null : opinion === null ? "AI_DEFERRED" : opinion === r.decision ? "AGREE" : "DISAGREE";
    return {
      reviewId: r.reviewId,
      locationId: r.locationId,
      externalId: r.externalId,
      name: r.name,
      clientName: r.clientName,
      reviewerName: r.reviewerName,
      decision: r.decision,
      aiRecommendation: r.aiRecommendation,
      aiServices: ai.aiServices,
      agreement,
      /** AI would have approved; the person rejected — the shadow-mode warning sign for false approvals. */
      aiApproveHumanReject: opinion === "APPROVE" && r.decision === "REJECT",
      aiSeconds: r.runStarted && r.runCompleted ? (r.runCompleted.getTime() - r.runStarted.getTime()) / 1000 : null,
      humanSeconds: r.openedAt ? Math.max(0, (r.submittedAt.getTime() - r.openedAt.getTime()) / 1000) : null,
      decidedAt: r.submittedAt,
    };
  });
  const conf = confidenceAgreement(facts);
  const services: Record<string, { agree: number; total: number }> = {};
  for (const fct of facts) {
    if (fct.decision === "ESCALATE") continue;
    for (const [svc, a] of Object.entries(fct.aiServices)) {
      const aiSays = a.status === "SUPPORTED" ? "APPROVE" : a.status === "NOT_SUPPORTED" || a.status === "CONTRADICTORY" ? "REJECT" : null;
      if (!aiSays) continue;
      const s = (services[svc] ??= { agree: 0, total: 0 });
      s.total++;
      if ((fct.serviceDecisions[svc] ?? fct.decision) === aiSays) s.agree++;
    }
  }
  const decided = items.filter((i) => i.agreement !== null);
  return {
    minSample,
    summary: {
      decisions: decided.length,
      agreement: rate(ag.agree, ag.opinions, minSample),
      aiDeferred: rate(ag.deferred, decided.length, minSample),
      aiApproveHumanReject: { ...rate(ag.approveSuggestedRejected, ag.approveSuggested, minSample), ci95: wilson(ag.approveSuggestedRejected, ag.approveSuggested) },
      aiRejectHumanApprove: rate(ag.rejectSuggestedApproved, ag.rejectSuggested, minSample),
      byService: Object.fromEntries(Object.entries(services).map(([k, v]) => [k, rate(v.agree, v.total, minSample)])),
      byConfidence: Object.fromEntries(Object.entries(conf).map(([k, v]) => [k, rate(v.agree, v.total, minSample)])),
      aiSecondsMedian: median(items.map((i) => i.aiSeconds).filter((x): x is number => x !== null)),
      humanSecondsMedian: median(items.map((i) => i.humanSeconds).filter((x): x is number => x !== null && x < 4 * 3600)),
    },
    items,
  };
}
