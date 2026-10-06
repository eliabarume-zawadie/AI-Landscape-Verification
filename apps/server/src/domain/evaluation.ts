import { GOLDEN_CASE_TAGS } from "@alvip/shared";

/**
 * Golden-dataset scoring (PRD §54–56, §70). Pure functions.
 *
 * The AI's per-service status becomes a prediction:
 *   SUPPORTED → APPROVE;  NOT_SUPPORTED / CONTRADICTORY → REJECT;
 *   INSUFFICIENT_EVIDENCE / UNABLE_TO_DETERMINE → NO_DECISION (the AI hands it to a person).
 * The location recommendation likewise: RECOMMEND_APPROVE / RECOMMEND_REJECT / NEEDS_HUMAN_REVIEW.
 *
 * A false approval (AI says approve, truth is reject) is the highest-risk error (PRD §5), so
 * its rate is reported with a 95% Wilson interval: with few examples the interval is wide,
 * and that width is the honest answer.
 */

export type Predicted = "APPROVE" | "REJECT" | "NO_DECISION";
export type Outcome = "CORRECT" | "FALSE_APPROVAL" | "FALSE_REJECTION" | "DEFERRED" | "ERROR";

export function predictFromStatus(status: string | null | undefined): Predicted {
  if (status === "SUPPORTED") return "APPROVE";
  if (status === "NOT_SUPPORTED" || status === "CONTRADICTORY") return "REJECT";
  return "NO_DECISION";
}

export function predictFromRecommendation(rec: string | null | undefined): Predicted {
  if (rec === "RECOMMEND_APPROVE") return "APPROVE";
  if (rec === "RECOMMEND_REJECT") return "REJECT";
  return "NO_DECISION";
}

export function outcomeOf(expected: "APPROVE" | "REJECT", predicted: Predicted, failed = false): Outcome {
  if (failed) return "ERROR";
  if (predicted === "NO_DECISION") return "DEFERRED";
  if (predicted === expected) return "CORRECT";
  return predicted === "APPROVE" ? "FALSE_APPROVAL" : "FALSE_REJECTION";
}

/** The location is "approve" only if every required service is approve. */
export function expectedForLocation(expected: Record<string, "APPROVE" | "REJECT">): "APPROVE" | "REJECT" {
  return Object.values(expected).every((e) => e === "APPROVE") ? "APPROVE" : "REJECT";
}

/** 95% Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n === 0) return null;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export interface Proportion {
  value: number | null;
  k: number;
  n: number;
  ci95: { low: number; high: number } | null;
}
const prop = (k: number, n: number): Proportion => ({ value: n ? k / n : null, k, n, ci95: wilson(k, n) });

export interface ScoredRow {
  exampleId: string;
  /** null = location-level row. */
  serviceCode: string | null;
  expected: "APPROVE" | "REJECT";
  predicted: Predicted;
  outcome: Outcome;
  aiConfidence: string | null;
  clientName: string;
  tags: string[];
  imageQuality: "GOOD" | "POOR";
  /** Historical reviewer decision for the example (location level), if known. */
  reviewerDecision: string | null;
}

export interface Metrics {
  samples: number;
  correct: number;
  incorrect: number;
  falseApprovals: number;
  falseRejections: number;
  deferred: number;
  errors: number;
  /** False approvals ÷ examples whose truth is REJECT (including ones the AI deferred). */
  falseApprovalRate: Proportion;
  /** False rejections ÷ examples whose truth is APPROVE. */
  falseRejectionRate: Proportion;
  /** Of the AI's approve predictions, how many were right. */
  precision: Proportion;
  /** Of the true approvals, how many the AI approved (deferrals count as misses). */
  recall: Proportion;
  /** Accuracy where the AI did decide. */
  accuracyWhenDecided: Proportion;
  deferralRate: Proportion;
  /** Examples where the historical reviewer decided differently from the AI's prediction. */
  humanOverride: number;
  /** Fewer samples than the configured minimum: not enough to support an automation decision. */
  smallSample: boolean;
}

export function computeMetrics(rows: ScoredRow[], minSample: number): Metrics {
  const count = (o: Outcome) => rows.filter((r) => r.outcome === o).length;
  const truthReject = rows.filter((r) => r.expected === "REJECT" && r.outcome !== "ERROR");
  const truthApprove = rows.filter((r) => r.expected === "APPROVE" && r.outcome !== "ERROR");
  const predictedApprove = rows.filter((r) => r.predicted === "APPROVE" && r.outcome !== "ERROR");
  const decided = rows.filter((r) => r.predicted !== "NO_DECISION" && r.outcome !== "ERROR");
  const valid = rows.filter((r) => r.outcome !== "ERROR");
  return {
    samples: rows.length,
    correct: count("CORRECT"),
    incorrect: count("FALSE_APPROVAL") + count("FALSE_REJECTION"),
    falseApprovals: count("FALSE_APPROVAL"),
    falseRejections: count("FALSE_REJECTION"),
    deferred: count("DEFERRED"),
    errors: count("ERROR"),
    falseApprovalRate: prop(truthReject.filter((r) => r.outcome === "FALSE_APPROVAL").length, truthReject.length),
    falseRejectionRate: prop(truthApprove.filter((r) => r.outcome === "FALSE_REJECTION").length, truthApprove.length),
    precision: prop(predictedApprove.filter((r) => r.expected === "APPROVE").length, predictedApprove.length),
    recall: prop(truthApprove.filter((r) => r.predicted === "APPROVE").length, truthApprove.length),
    accuracyWhenDecided: prop(decided.filter((r) => r.outcome === "CORRECT").length, decided.length),
    deferralRate: prop(valid.filter((r) => r.outcome === "DEFERRED").length, valid.length),
    humanOverride: rows.filter((r) => r.reviewerDecision && r.predicted !== "NO_DECISION" && r.reviewerDecision !== r.predicted).length,
    smallSample: rows.length < minSample,
  };
}

function groupBy(rows: ScoredRow[], key: (r: ScoredRow) => string[], minSample: number): Record<string, Metrics> {
  const groups = new Map<string, ScoredRow[]>();
  for (const r of rows) for (const k of key(r)) groups.set(k, [...(groups.get(k) ?? []), r]);
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, g]) => [k, computeMetrics(g, minSample)]));
}

export interface EvaluationSummary {
  /** Per-service rows (PRD §56 report). */
  overall: Metrics;
  /** Location-level recommendation vs the location truth. */
  location: Metrics;
  byService: Record<string, Metrics>;
  byClient: Record<string, Metrics>;
  byTag: Record<string, Metrics>;
  byImageQuality: Record<string, Metrics>;
  /** Calibration: per AI confidence band, accuracy where the AI decided. */
  byConfidence: Record<string, Metrics>;
  coverage: { tag: string; examples: number }[];
  missingCoverage: string[];
}

export function summarize(rows: ScoredRow[], minSample: number): EvaluationSummary {
  const svc = rows.filter((r) => r.serviceCode !== null);
  const loc = rows.filter((r) => r.serviceCode === null);
  const coverage = GOLDEN_CASE_TAGS.map((tag) => ({ tag, examples: loc.filter((r) => r.tags.includes(tag)).length }));
  return {
    overall: computeMetrics(svc, minSample),
    location: computeMetrics(loc, minSample),
    byService: groupBy(svc, (r) => [r.serviceCode!], minSample),
    byClient: groupBy(svc, (r) => [r.clientName], minSample),
    byTag: groupBy(svc, (r) => (r.tags.length ? r.tags : ["UNTAGGED"]), minSample),
    byImageQuality: groupBy(svc, (r) => [r.imageQuality], minSample),
    byConfidence: groupBy(
      svc.filter((r) => r.aiConfidence),
      (r) => [r.aiConfidence!],
      minSample,
    ),
    coverage,
    missingCoverage: coverage.filter((c) => c.examples === 0).map((c) => c.tag),
  };
}
