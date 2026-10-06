/**
 * Dashboard metric rules (PRD §4, §44). Pure functions; the dashboard service feeds them.
 *
 * Honesty rules:
 *  - A rate over fewer than `minSample` cases is suppressed (value null), never shown as a
 *    percentage that looks meaningful (thresholds.metrics.min_sample_size).
 *  - Agreement with reviewers is not accuracy. False approval/rejection rates need checked
 *    ground truth (golden set, QC sampling) and are reported as not measured until then.
 */

export interface Rate {
  /** 0..1, or null when suppressed / no data. */
  value: number | null;
  numerator: number;
  denominator: number;
  /** True when the denominator is below the minimum sample size. */
  suppressed: boolean;
}

export function rate(numerator: number, denominator: number, minSample: number): Rate {
  const suppressed = denominator < minSample;
  return { value: suppressed || denominator === 0 ? null : numerator / denominator, numerator, denominator, suppressed };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export interface ReviewFact {
  decision: "APPROVE" | "REJECT" | "ESCALATE";
  aiRecommendation: string | null;
  isOverride: boolean;
  /** Per-service AI view frozen at decision time. */
  aiServices: Record<string, { status: string; confidence: string }>;
  serviceDecisions: Record<string, string>;
}

/**
 * The AI "has an opinion" only when it recommended approve or reject. NEEDS_HUMAN_REVIEW is
 * the AI deferring, so it is counted separately, not as agreement or disagreement.
 */
export function agreementCounts(reviews: ReviewFact[]) {
  let agree = 0;
  let opinions = 0;
  let deferred = 0;
  let approveSuggested = 0;
  let approveSuggestedRejected = 0;
  let rejectSuggested = 0;
  let rejectSuggestedApproved = 0;
  for (const r of reviews) {
    if (r.decision === "ESCALATE") continue;
    if (r.aiRecommendation === "NEEDS_HUMAN_REVIEW") deferred++;
    if (r.aiRecommendation === "RECOMMEND_APPROVE") {
      opinions++;
      approveSuggested++;
      if (r.decision === "APPROVE") agree++;
      else approveSuggestedRejected++;
    }
    if (r.aiRecommendation === "RECOMMEND_REJECT") {
      opinions++;
      rejectSuggested++;
      if (r.decision === "REJECT") agree++;
      else rejectSuggestedApproved++;
    }
  }
  return { agree, opinions, deferred, approveSuggested, approveSuggestedRejected, rejectSuggested, rejectSuggestedApproved };
}

/**
 * Per-service agreement by AI confidence band ("calibration" against reviewers, PRD §4).
 * SUPPORTED agrees with a human approve; NOT_SUPPORTED / CONTRADICTORY agree with a reject.
 * INSUFFICIENT_EVIDENCE / UNABLE_TO_DETERMINE are the AI not deciding: excluded.
 */
export function confidenceAgreement(reviews: ReviewFact[]): Record<string, { agree: number; total: number }> {
  const out: Record<string, { agree: number; total: number }> = { HIGH: { agree: 0, total: 0 }, MEDIUM: { agree: 0, total: 0 }, LOW: { agree: 0, total: 0 } };
  for (const r of reviews) {
    if (r.decision === "ESCALATE") continue;
    for (const [service, ai] of Object.entries(r.aiServices)) {
      const aiSays = ai.status === "SUPPORTED" ? "APPROVE" : ai.status === "NOT_SUPPORTED" || ai.status === "CONTRADICTORY" ? "REJECT" : null;
      if (!aiSays || !out[ai.confidence]) continue;
      const human = r.serviceDecisions[service] ?? r.decision;
      out[ai.confidence]!.total++;
      if (human === aiSays) out[ai.confidence]!.agree++;
    }
  }
  return out;
}

export interface QueueSnapshot {
  awaitingReview: number;
  oldestAwaitingMinutes: number | null;
  inProgress: number;
  oldestUnprocessedMinutes: number | null;
  errorsByStatus: Record<string, number>;
  waitingForNetSuite: number;
  netsuiteStopped: number;
  pendingJobs: number;
  minutesSinceLastJobFinished: number | null;
  recentErrorsByCategory: Record<string, number>;
  decidedToday: number;
  remaining: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ago = (minutes: number) => (minutes < 90 ? `${Math.round(minutes)} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`);

/** "Why is today's queue not clearing?" (PRD §79), as plain sentences, most important first. */
export function diagnose(s: QueueSnapshot): { level: "ok" | "info" | "warn"; text: string }[] {
  const out: { level: "ok" | "info" | "warn"; text: string }[] = [];
  if (s.pendingJobs > 0 && s.minutesSinceLastJobFinished !== null && s.minutesSinceLastJobFinished > 10) {
    out.push({ level: "warn", text: `Processing looks stalled: ${plural(s.pendingJobs, "job")} waiting and none finished in the last ${ago(s.minutesSinceLastJobFinished)}. Check that the worker is running.` });
  }
  const auth = s.recentErrorsByCategory.AUTHENTICATION ?? 0;
  if (auth > 0) out.push({ level: "warn", text: `${plural(auth, "login failure")} with an external service in the last hour. An admin must check the integration credentials.` });
  const ai = (s.recentErrorsByCategory.MODEL_ERROR ?? 0) + (s.errorsByStatus.AI_ERROR ?? 0);
  if (ai > 0) {
    const n = s.errorsByStatus.AI_ERROR ?? 0;
    out.push({ level: "warn", text: `The AI provider is failing: ${plural(n, "location")} stopped with an AI problem. A team lead can send ${n === 1 ? "it" : "them"} to manual review.` });
  }
  if (s.netsuiteStopped > 0) out.push({ level: "warn", text: `${plural(s.netsuiteStopped, "decision")} could not be sent to NetSuite. Open them from the Problems lane and retry once the cause is fixed.` });
  const photo = s.errorsByStatus.IMAGE_ERROR ?? 0;
  const data = s.errorsByStatus.INTEGRATION_ERROR ?? 0;
  if (photo + data > 0) out.push({ level: "info", text: `${plural(photo + data, "location")} need attention in the Problems lane (${photo} photo, ${data} data problems).` });
  if (s.awaitingReview > 0) {
    out.push({
      level: s.oldestAwaitingMinutes !== null && s.oldestAwaitingMinutes > 8 * 60 ? "warn" : "info",
      text: `${plural(s.awaitingReview, "location")} waiting for a reviewer${s.oldestAwaitingMinutes !== null ? `; the oldest has waited ${ago(s.oldestAwaitingMinutes)}` : ""}.`,
    });
  }
  if (s.inProgress > 0) out.push({ level: "info", text: `${plural(s.inProgress, "location")} still being analysed${s.oldestUnprocessedMinutes !== null ? ` (oldest received ${ago(s.oldestUnprocessedMinutes)} ago)` : ""}.` });
  if (s.waitingForNetSuite > 0) out.push({ level: "info", text: `${plural(s.waitingForNetSuite, "decision")} on the way to NetSuite.` });
  if (out.length === 0) out.push({ level: "ok", text: s.decidedToday > 0 ? `Queue is clear: ${plural(s.decidedToday, "location")} decided and nothing waiting.` : "Nothing waiting." });
  return out;
}
