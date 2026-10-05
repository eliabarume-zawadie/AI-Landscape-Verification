import type { AiRecommendation, Lane, RiskFactor, RiskLevel, Thresholds } from "@alvip/shared";
import type { ServiceAssessment } from "./evidence";

/**
 * Risk engine, recommendation and lane (PRD §24, §27, §35–36, §53). Deterministic.
 *
 * Risk = how likely an AI-assisted decision could be wrong. The internal score is the sum
 * of present factor weights (capped at 1) banded by medium_at/high_at; some factors force
 * a minimum level. Users see the level and the named factors, never the score (PRD §24).
 */

export interface RiskImageStats {
  total: number;
  /** Readable images (present, decodable, accepted format). */
  readable: number;
  usable: number;
  /** Non-representative members of duplicate clusters. */
  duplicates: number;
  /** Images the vision model marked IRRELEVANT / OBSTRUCTED / TOO_DISTANT. */
  unusualScene: number;
  /** Vision outcomes MALFORMED or REFUSED. */
  analysisFailures: number;
}

export interface RiskInput {
  assessments: readonly ServiceAssessment[];
  images: RiskImageStats;
  /** Services that require before/after per the effective rules. */
  servicesRequiringBeforeAfter: readonly string[];
  clientRequiresHumanReview: boolean;
  thresholds: Thresholds;
}

export interface RiskFactorHit {
  factor: RiskFactor;
  weight: number;
  /** Plain-language detail for reviewers (which services / how many images). */
  detail: string;
}

export interface RiskResult {
  level: RiskLevel;
  /** Internal and uncalibrated: never shown to users. */
  internalScore: number;
  factors: RiskFactorHit[];
}

const LEVELS: RiskLevel[] = ["LOW", "MEDIUM", "HIGH"];
const max = (a: RiskLevel, b: RiskLevel): RiskLevel => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);
const names = (xs: readonly ServiceAssessment[]) => xs.map((a) => a.service).sort().join(", ");

export function assessRisk(input: RiskInput): RiskResult {
  const t = input.thresholds.risk;
  const hits: RiskFactorHit[] = [];
  const hit = (factor: RiskFactor, detail: string) => hits.push({ factor, weight: t.weights[factor] ?? 0, detail });
  const by = (status: ServiceAssessment["status"]) => input.assessments.filter((a) => a.status === status);

  const contradictory = by("CONTRADICTORY");
  if (contradictory.length) hit("CONTRADICTION", `Contradictory evidence for ${names(contradictory)}`);
  const unable = by("UNABLE_TO_DETERMINE");
  if (unable.length) hit("UNABLE_TO_DETERMINE", `AI could not determine ${names(unable)}`);
  const notSupported = by("NOT_SUPPORTED");
  if (notSupported.length) hit("NOT_SUPPORTED", `Evidence does not support ${names(notSupported)}`);
  const insufficient = by("INSUFFICIENT_EVIDENCE");
  if (insufficient.length) hit("INSUFFICIENT_EVIDENCE", `Insufficient evidence for ${names(insufficient)}`);

  const ruled = input.assessments.filter((a) => a.reasons.includes("RULE_REQUIRES_HUMAN_REVIEW"));
  if (input.clientRequiresHumanReview || ruled.length) {
    hit("CLIENT_STRICT_RULE", input.clientRequiresHumanReview ? "Client requires human review" : `Rules require human review for ${names(ruled)}`);
  }
  if (input.images.analysisFailures > 0) hit("ANALYSIS_FAILURES", `${input.images.analysisFailures} image(s) could not be analysed by the AI`);

  const missingBA = input.assessments.filter(
    (a) =>
      input.servicesRequiringBeforeAfter.includes(a.service) &&
      a.reasons.some((r) => r === "BEFORE_AFTER_NOT_ESTABLISHED" || r === "BEFORE_AFTER_NOT_YET_EVALUATED"),
  );
  if (missingBA.length) hit("MISSING_BEFORE_AFTER", `No confirmed before/after for ${names(missingBA)}`);

  const weakCounter = input.assessments.filter((a) => a.reasons.includes("WEAK_COUNTER_EVIDENCE"));
  if (weakCounter.length) hit("WEAK_COUNTER_EVIDENCE", `Some counter-evidence for ${names(weakCounter)}`);

  if (by("SUPPORTED").length > 0 && (notSupported.length > 0 || contradictory.length > 0)) {
    hit("CONFLICTING_SERVICE_OUTCOMES", "Some services are supported while others are not");
  }
  const lowConf = by("SUPPORTED").filter((a) => a.confidence !== "HIGH");
  if (lowConf.length) hit("LOW_CONFIDENCE", `Supported with less than high confidence: ${names(lowConf)}`);

  const ratio = (n: number) => (input.images.total === 0 ? 0 : n / input.images.total);
  if (ratio(input.images.total - input.images.usable) >= t.poor_quality_ratio) {
    hit("POOR_IMAGE_QUALITY", `${input.images.total - input.images.usable} of ${input.images.total} images are unusable`);
  }
  if (ratio(input.images.unusualScene) >= t.unusual_scene_ratio) {
    hit("UNUSUAL_SCENE", `${input.images.unusualScene} image(s) are irrelevant, obstructed or too distant`);
  }
  if (ratio(input.images.duplicates) >= t.duplicate_heavy_ratio) {
    hit("DUPLICATE_HEAVY", `${input.images.duplicates} of ${input.images.total} images are duplicates`);
  }

  const score = Math.min(1, hits.reduce((s, h) => s + h.weight, 0));
  let level: RiskLevel = score >= t.high_at ? "HIGH" : score >= t.medium_at ? "MEDIUM" : "LOW";
  for (const h of hits) {
    const floor = t.floors[h.factor];
    if (floor) level = max(level, floor);
  }
  return { level, internalScore: Math.round(score * 1000) / 1000, factors: hits.sort((a, b) => b.weight - a.weight || a.factor.localeCompare(b.factor)) };
}

export interface Recommendation {
  recommendation: AiRecommendation;
  explanation: string;
}

/**
 * The AI's suggestion to the reviewer. It never decides: approval is only reachable from
 * a human-review state (domain/locationState.ts).
 */
export function recommend(assessments: readonly ServiceAssessment[], risk: RiskResult): Recommendation {
  const all = (s: ServiceAssessment["status"]) => assessments.length > 0 && assessments.every((a) => a.status === s);
  const any = (s: ServiceAssessment["status"]) => assessments.some((a) => a.status === s);
  const ruleRequiresHuman = risk.factors.some((f) => f.factor === "CLIENT_STRICT_RULE");

  // Approve only when nothing is flagged: every service SUPPORTED with HIGH confidence and
  // no per-service human-review flag (single image, weak counter-evidence, failed analyses…).
  if (all("SUPPORTED") && assessments.every((a) => !a.humanRequired) && risk.level === "LOW" && !ruleRequiresHuman) {
    return { recommendation: "RECOMMEND_APPROVE", explanation: "Every required service is supported by strong, independent evidence, with low risk." };
  }
  if (any("NOT_SUPPORTED") && !any("CONTRADICTORY") && !any("UNABLE_TO_DETERMINE")) {
    const ns = assessments.filter((a) => a.status === "NOT_SUPPORTED").map((a) => a.service).sort();
    return { recommendation: "RECOMMEND_REJECT", explanation: `The evidence does not support: ${ns.join(", ")}.` };
  }
  const flagged = assessments.filter((a) => a.humanRequired).map((a) => a.service).sort();
  const why = risk.factors.slice(0, 3).map((f) => f.detail.toLowerCase());
  if (why.length === 0 && flagged.length > 0) why.push(`needs a closer look: ${flagged.join(", ")}`);
  return {
    recommendation: "NEEDS_HUMAN_REVIEW",
    explanation: `A reviewer needs to decide${why.length ? `: ${why.join("; ")}` : ""}.`,
  };
}

/**
 * PRD §36, §53. Fast Lane only at automation level 3, for a low-risk approve
 * recommendation, and never in shadow mode. Fast Lane still needs a human to confirm.
 */
export function chooseLane(args: { recommendation: AiRecommendation; risk: RiskLevel; automationLevel: number; shadowMode: boolean }): Lane {
  if (args.automationLevel >= 3 && !args.shadowMode && args.recommendation === "RECOMMEND_APPROVE" && args.risk === "LOW") return "FAST";
  return "HUMAN_REVIEW";
}
