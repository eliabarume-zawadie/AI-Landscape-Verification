import type { ClientProfile, ConfidenceLevel, ServiceAssessmentStatus, Thresholds } from "@alvip/shared";
import type { Observation } from "./observations";
import { resolveServiceRules, type EffectiveServiceRules, type ServiceRegistry } from "./serviceRegistry";

/**
 * Service Evidence Engine (PRD §19–21, §26). Deterministic: turns validated vision
 * observations into one assessment per required service. No model output is trusted as
 * a conclusion; the model only supplied observations.
 */

export interface EvidenceImage {
  imageId: string;
  ref: string;
  ordinal: number | null;
  usable: boolean;
  isRepresentative: boolean;
  duplicateGroup: string;
  /** Vision outcome (ANALYZED | CACHED | SKIPPED_* | MALFORMED | REFUSED | null). */
  analysisStatus: string | null;
  observations: Observation[];
  notAssessable: { service: string; reason: string }[];
}

/**
 * Inputs from later stages. Until a stage has run, its value is undefined and any rule
 * that depends on it fails closed (cannot produce SUPPORTED).
 */
export interface StageInputs {
  /** Phase 6: services for which a before/after pair establishes the change. */
  beforeAfterEstablished?: ReadonlySet<string>;
  /** Phase 6/7: number of distinct scenes covered by usable images. */
  distinctScenes?: number;
  /**
   * Phase 6: images identified as BEFORE photos of a before/after pair. Negative evidence
   * in a before photo is the expected baseline, not a contradiction. Until provided, every
   * negative observation counts as counter-evidence (conservative).
   */
  beforeImageIds?: ReadonlySet<string>;
}

export interface EvidenceContext {
  registry: ServiceRegistry;
  profile: ClientProfile;
  thresholds: Thresholds;
  images: readonly EvidenceImage[];
  stage: StageInputs;
}

export interface EvidenceItem {
  imageId: string;
  ref: string;
  duplicateGroup: string;
  evidenceType: string;
  polarity: "positive" | "negative" | "context";
  strength: number;
  description: string;
  /** Negative evidence from a before photo: recorded as context, never counted against. */
  baseline?: boolean;
}

export interface ServiceAssessment {
  service: string;
  status: ServiceAssessmentStatus;
  confidence: ConfidenceLevel;
  /** Uncalibrated, internal only (PRD §24/§33). */
  internalScore: number;
  humanRequired: boolean;
  reasons: string[];
  explanation: string;
  supporting: EvidenceItem[];
  contradicting: EvidenceItem[];
  context: EvidenceItem[];
  contradictions: { supporting: EvidenceItem; contradicting: EvidenceItem; description: string }[];
  /** Decomposed services (landscape maintenance): component statuses. */
  components?: Record<string, ServiceAssessmentStatus>;
}

const EVIDENCE_STATUSES = new Set(["ANALYZED", "CACHED"]);
const FAILED_STATUSES = new Set(["MALFORMED", "REFUSED"]);

/** Images whose observations may count: analysed, usable, one per duplicate cluster. */
export function eligibleImages(images: readonly EvidenceImage[]): EvidenceImage[] {
  return images.filter((i) => i.usable && i.isRepresentative && i.analysisStatus !== null && EVIDENCE_STATUSES.has(i.analysisStatus));
}

export function band(score: number, t: Thresholds): ConfidenceLevel {
  if (score >= t.confidence_bands.high) return "HIGH";
  if (score >= t.confidence_bands.medium) return "MEDIUM";
  return "LOW";
}

/** Assess every required service of a location. */
export function assessLocation(ctx: EvidenceContext, requiredServices: readonly string[]): ServiceAssessment[] {
  return [...requiredServices].sort().map((s) => assessService(ctx, s));
}

export function assessService(ctx: EvidenceContext, serviceCode: string): ServiceAssessment {
  const rules = resolveServiceRules(ctx.registry, ctx.profile, serviceCode);
  if (rules.requiredComponents.length > 0) return assessDecomposed(ctx, rules);
  return assessSimple(ctx, rules);
}

// ------------------------------------------------------------------ simple services

function assessSimple(ctx: EvidenceContext, rules: EffectiveServiceRules): ServiceAssessment {
  const t = ctx.thresholds;
  const eligible = eligibleImages(ctx.images);
  const items = collect(eligible, rules, ctx.stage.beforeImageIds);
  const reasons: string[] = [];

  // Positive evidence that may support on its own (not in insufficient_alone).
  const insufficientAlone = new Set(rules.definition.insufficient_alone);
  const qualifying = items.positive.filter((i) => !insufficientAlone.has(i.evidenceType));
  const nonQualifyingPositive = items.positive.filter((i) => insufficientAlone.has(i.evidenceType));

  const supportClusters = bestPerCluster(qualifying);
  const supportScore = Math.max(0, ...supportClusters.map((i) => i.strength));
  const counter = items.negative.filter((i) => i.strength >= t.evidence.counter_evidence_min_strength);
  const weakCounter = items.negative.filter((i) => i.strength < t.evidence.counter_evidence_min_strength);
  const counterClusters = bestPerCluster(counter);
  const counterScore = Math.max(0, ...counterClusters.map((i) => i.strength));
  const strongSupport = supportClusters.filter((i) => i.strength >= t.confidence_bands.medium);

  let status: ServiceAssessmentStatus;
  let confidence: ConfidenceLevel = "LOW";
  let score = 0;
  const contradictions: ServiceAssessment["contradictions"] = [];

  const analysisFailures = ctx.images.filter((i) => i.analysisStatus && FAILED_STATUSES.has(i.analysisStatus)).length;

  if (eligible.length === 0) {
    if (analysisFailures > 0) {
      status = "UNABLE_TO_DETERMINE";
      reasons.push("AI_ANALYSIS_FAILED");
    } else {
      status = "INSUFFICIENT_EVIDENCE";
      reasons.push("NO_USABLE_ANALYSED_IMAGES");
    }
  } else if (strongSupport.length > 0 && counterClusters.length > 0) {
    status = "CONTRADICTORY";
    reasons.push("CONTRADICTING_EVIDENCE");
    score = Math.min(supportScore, counterScore);
    for (const c of counterClusters) {
      const s = strongSupport.find((x) => x.duplicateGroup !== c.duplicateGroup) ?? strongSupport[0]!;
      contradictions.push({
        supporting: s,
        contradicting: c,
        description: `${s.ref} shows ${label(s.evidenceType)}, but ${c.ref} shows ${label(c.evidenceType)}.`,
      });
    }
  } else if (counterClusters.length > 0) {
    status = "NOT_SUPPORTED";
    reasons.push("NEGATIVE_EVIDENCE_ONLY");
    score = counterScore;
    confidence = capByIndependence(band(counterScore, t), counterClusters.length, t);
  } else if (supportClusters.length === 0) {
    status = "INSUFFICIENT_EVIDENCE";
    if (nonQualifyingPositive.length > 0 || items.context.length > 0) reasons.push("ONLY_CONTEXT_EVIDENCE");
    else reasons.push("NO_RELEVANT_EVIDENCE");
  } else if (supportScore < rules.minimumConfidenceForAssistance) {
    status = "INSUFFICIENT_EVIDENCE";
    reasons.push("BELOW_CONFIDENCE_THRESHOLD");
    score = supportScore;
  } else {
    // Positive evidence is strong enough; every remaining requirement must be met.
    const blockers = requirementBlockers(ctx, rules, eligible);
    reasons.push(...blockers);
    score = supportScore;
    if (blockers.length > 0) {
      status = "INSUFFICIENT_EVIDENCE";
    } else {
      status = "SUPPORTED";
      confidence = capByIndependence(band(supportScore, t), supportClusters.length, t);
      if (supportClusters.length < t.evidence.min_independent_images_for_high) reasons.push("SINGLE_INDEPENDENT_IMAGE");
    }
  }

  if (weakCounter.length > 0 && status === "SUPPORTED") reasons.push("WEAK_COUNTER_EVIDENCE");
  if (analysisFailures > 0 && status !== "UNABLE_TO_DETERMINE") reasons.push("SOME_IMAGES_NOT_ANALYSED");
  if (rules.humanReviewRequiredByRule) reasons.push("RULE_REQUIRES_HUMAN_REVIEW");

  const humanRequired =
    status !== "SUPPORTED" ||
    confidence !== "HIGH" ||
    rules.humanReviewRequiredByRule ||
    reasons.some((r) => r === "WEAK_COUNTER_EVIDENCE" || r === "SOME_IMAGES_NOT_ANALYSED");

  const assessment: ServiceAssessment = {
    service: rules.code,
    status,
    confidence,
    internalScore: round3(score),
    humanRequired,
    reasons,
    explanation: "",
    supporting: sortByStrength(items.positive),
    contradicting: sortByStrength(items.negative),
    context: sortByStrength(items.context),
    contradictions,
  };
  assessment.explanation = explain(assessment, rules, supportClusters, counterClusters, ctx.images);
  return assessment;
}

/** Requirements that must hold before SUPPORTED. Unevaluated requirements fail closed. */
function requirementBlockers(ctx: EvidenceContext, rules: EffectiveServiceRules, eligible: EvidenceImage[]): string[] {
  const blockers: string[] = [];
  if (rules.requiresBeforeAfter) {
    if (ctx.stage.beforeAfterEstablished === undefined) blockers.push("BEFORE_AFTER_NOT_YET_EVALUATED");
    else if (!ctx.stage.beforeAfterEstablished.has(rules.code)) blockers.push("BEFORE_AFTER_NOT_ESTABLISHED");
  }
  const req = ctx.profile.image_requirements;
  if (req.min_usable_images !== undefined && eligible.length < req.min_usable_images) {
    blockers.push("MIN_USABLE_IMAGES_NOT_MET");
  }
  if (req.min_distinct_scenes !== undefined) {
    if (ctx.stage.distinctScenes === undefined) blockers.push("SCENE_COVERAGE_NOT_YET_EVALUATED");
    else if (ctx.stage.distinctScenes < req.min_distinct_scenes) blockers.push("MIN_DISTINCT_SCENES_NOT_MET");
  }
  return blockers;
}

// ------------------------------------------------------------------ decomposed services

const STATUS_SEVERITY: ServiceAssessmentStatus[] = [
  "CONTRADICTORY",
  "NOT_SUPPORTED",
  "UNABLE_TO_DETERMINE",
  "INSUFFICIENT_EVIDENCE",
  "SUPPORTED",
];

/**
 * PRD §63: broad services are judged through their observable components. The result is
 * the most severe component status; the service's own evidence (e.g. plant beds) can
 * add contradictions but never upgrade a component.
 */
function assessDecomposed(ctx: EvidenceContext, rules: EffectiveServiceRules): ServiceAssessment {
  const components = rules.requiredComponents.map((c) => assessSimple(ctx, resolveServiceRules(ctx.registry, ctx.profile, c)));
  const own = assessSimple(ctx, { ...rules, requiredComponents: [], requiresBeforeAfter: false });

  const statuses = components.map((c) => c.status);
  // The service's own evidence types only matter when they contradict or negate.
  if (own.status === "CONTRADICTORY" || own.status === "NOT_SUPPORTED") statuses.push(own.status);
  const status = STATUS_SEVERITY.find((s) => statuses.includes(s)) ?? "INSUFFICIENT_EVIDENCE";

  const confidenceOrder: ConfidenceLevel[] = ["LOW", "MEDIUM", "HIGH"];
  const confidence =
    status === "SUPPORTED"
      ? confidenceOrder[Math.min(...components.map((c) => confidenceOrder.indexOf(c.confidence)))]!
      : "LOW";

  const reasons = [
    ...components.filter((c) => c.status !== "SUPPORTED").map((c) => `COMPONENT_${c.service.toUpperCase()}_${c.status}`),
    ...(own.status === "CONTRADICTORY" || own.status === "NOT_SUPPORTED" ? own.reasons : []),
    ...(rules.humanReviewRequiredByRule ? ["RULE_REQUIRES_HUMAN_REVIEW"] : []),
  ];
  const componentLine = components.map((c) => `${c.service}: ${c.status}`).join("; ");
  return {
    service: rules.code,
    status,
    confidence,
    internalScore: Math.min(...components.map((c) => c.internalScore)),
    humanRequired: status !== "SUPPORTED" || confidence !== "HIGH" || rules.humanReviewRequiredByRule || components.some((c) => c.humanRequired),
    reasons,
    explanation: `${rules.displayName} is assessed through its required components (${componentLine}).${
      own.contradictions.length > 0 || own.status === "NOT_SUPPORTED" ? ` ${own.explanation}` : ""
    }`,
    supporting: dedupeItems([...own.supporting, ...components.flatMap((c) => c.supporting)]),
    contradicting: dedupeItems([...own.contradicting, ...components.flatMap((c) => c.contradicting)]),
    context: dedupeItems([...own.context, ...components.flatMap((c) => c.context)]),
    contradictions: [...own.contradictions, ...components.flatMap((c) => c.contradictions)],
    components: Object.fromEntries(components.map((c) => [c.service, c.status])),
  };
}

// ------------------------------------------------------------------ helpers

function collect(images: EvidenceImage[], rules: EffectiveServiceRules, beforeImageIds?: ReadonlySet<string>) {
  const positive: EvidenceItem[] = [];
  const negative: EvidenceItem[] = [];
  const context: EvidenceItem[] = [];
  const polarityOf = new Map(rules.definition.evidence_types.map((e) => [e.type, e.polarity]));
  for (const img of images) {
    for (const o of img.observations) {
      if (o.service !== rules.code) continue;
      // Polarity comes from the CURRENT rules, not whatever was stored with the observation.
      const polarity = polarityOf.get(o.evidenceType);
      if (!polarity) continue;
      const item: EvidenceItem = {
        imageId: img.imageId,
        ref: img.ref,
        duplicateGroup: img.duplicateGroup,
        evidenceType: o.evidenceType,
        polarity,
        strength: o.strength,
        description: o.description,
      };
      if (polarity === "negative" && beforeImageIds?.has(img.imageId)) {
        context.push({ ...item, baseline: true });
        continue;
      }
      // Positive evidence in a before photo cannot show the work was done; keep as context.
      if (polarity === "positive" && beforeImageIds?.has(img.imageId)) {
        context.push(item);
        continue;
      }
      (polarity === "positive" ? positive : polarity === "negative" ? negative : context).push(item);
    }
  }
  return { positive, negative, context };
}

/** One item per duplicate cluster (its strongest): duplicates never add confidence. */
function bestPerCluster(items: EvidenceItem[]): EvidenceItem[] {
  const best = new Map<string, EvidenceItem>();
  for (const i of items) {
    const prev = best.get(i.duplicateGroup);
    if (!prev || i.strength > prev.strength) best.set(i.duplicateGroup, i);
  }
  return sortByStrength([...best.values()]);
}

function capByIndependence(level: ConfidenceLevel, independentImages: number, t: Thresholds): ConfidenceLevel {
  return level === "HIGH" && independentImages < t.evidence.min_independent_images_for_high ? "MEDIUM" : level;
}

const sortByStrength = (items: EvidenceItem[]) =>
  [...items].sort((a, b) => b.strength - a.strength || a.ref.localeCompare(b.ref) || a.evidenceType.localeCompare(b.evidenceType));

function dedupeItems(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  return sortByStrength(items).filter((i) => {
    const k = `${i.imageId}:${i.evidenceType}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const label = (type: string) => type.replaceAll("_", " ");
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const refs = (items: EvidenceItem[]) => [...new Set(items.map((i) => i.ref))].join(", ");

const REASON_TEXT: Record<string, string> = {
  NO_USABLE_ANALYSED_IMAGES: "no usable image could be analysed",
  AI_ANALYSIS_FAILED: "the AI could not analyse the usable images",
  ONLY_CONTEXT_EVIDENCE: "the images only show context (e.g. equipment or general appearance), which cannot prove the service",
  NO_RELEVANT_EVIDENCE: "no image shows evidence related to this service",
  BELOW_CONFIDENCE_THRESHOLD: "the visible evidence is too weak or unclear",
  BEFORE_AFTER_NOT_YET_EVALUATED: "this service requires before/after evidence, which has not been evaluated yet",
  BEFORE_AFTER_NOT_ESTABLISHED: "this service requires before/after evidence and no matching pair was found",
  MIN_USABLE_IMAGES_NOT_MET: "fewer usable images than the client requires",
  SCENE_COVERAGE_NOT_YET_EVALUATED: "the client requires coverage of several distinct areas, which has not been evaluated yet",
  MIN_DISTINCT_SCENES_NOT_MET: "the images do not cover enough distinct areas for this client",
};

/** Deterministic, evidence-referencing explanation (PRD §32). */
function explain(
  a: ServiceAssessment,
  rules: EffectiveServiceRules,
  support: EvidenceItem[],
  counter: EvidenceItem[],
  images: readonly EvidenceImage[],
): string {
  const name = rules.displayName;
  const why = a.reasons.map((r) => REASON_TEXT[r]).filter(Boolean);
  switch (a.status) {
    case "SUPPORTED":
      return `${name} is supported: ${support.length} independent image(s) (${refs(support)}) show ${[...new Set(support.map((s) => label(s.evidenceType)))].join(", ")}. Strongest: "${support[0]!.description}" (${support[0]!.ref}).`;
    case "NOT_SUPPORTED":
      return `${name} is not supported: ${refs(counter)} show ${[...new Set(counter.map((c) => label(c.evidenceType)))].join(", ")}, and no image shows the work completed.`;
    case "CONTRADICTORY":
      return `${name} has contradictory evidence: ${a.contradictions.map((c) => c.description).join(" ")}`;
    case "UNABLE_TO_DETERMINE": {
      const failed = images.filter((i) => i.analysisStatus && FAILED_STATUSES.has(i.analysisStatus)).length;
      return `${name} could not be determined: the AI could not analyse ${failed} usable image(s).`;
    }
    case "INSUFFICIENT_EVIDENCE":
      return `${name} has insufficient evidence: ${why.join("; ") || "the images do not show enough"}.${
        support.length > 0 ? ` Positive signs seen in ${refs(support)}.` : ""
      }`;
  }
}
