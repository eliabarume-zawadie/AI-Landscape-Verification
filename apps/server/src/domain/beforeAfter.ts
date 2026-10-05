import type { ClientProfile, Thresholds } from "@alvip/shared";
import type { EvidenceImage, EvidenceItem, StageInputs } from "./evidence";
import type { ValidatedPairComparison } from "./observations";
import { resolveServiceRules, type ServiceRegistry } from "./serviceRegistry";
import type { StageResult } from "./stageClassification";

export interface EvaluatedPair {
  pairId: string;
  beforeId: string;
  afterId: string;
  /** Null when the comparison was malformed or refused (never evidence). */
  comparison: ValidatedPairComparison | null;
}

export function isConfirmedPair(p: EvaluatedPair, t: Thresholds["pairing"]): boolean {
  const c = p.comparison;
  return !!c && c.sameArea && c.comparisonPossible && c.sameAreaConfidence >= t.min_same_area_confidence;
}

/**
 * Turn stage labels and evaluated pairs into evidence-engine inputs (PRD §18–21).
 *
 *  - beforeImageIds: BEFORE photos whose negative evidence is baseline, not counter-
 *    evidence. Only when the label is STRONG (filename + time agree) or the photo is in
 *    a model-confirmed same-area pair. A weakly labelled, unpaired "before" keeps counting
 *    against the service — a mislabelled after-photo must never hide incomplete work.
 *  - beforeAfterEstablished: per service, a confirmed pair shows IMPROVED (≥ medium)
 *    AND the after-photo itself has qualifying positive evidence. Change alone is not proof.
 *  - distinctScenes: areas the vision model verified as mutually distinct (supplied by
 *    the caller). Never estimated from cheap visual features, which cannot reliably tell
 *    areas apart and could overcount.
 *  - pairCounterEvidence: NO_VISIBLE_CHANGE / WORSENED in a confirmed pair counts
 *    against the service, attributed to the after-photo.
 */
export function deriveStageInputs(args: {
  images: readonly EvidenceImage[];
  stages: ReadonlyMap<string, StageResult>;
  pairs: readonly EvaluatedPair[];
  services: readonly string[];
  registry: ServiceRegistry;
  profile: ClientProfile;
  thresholds: Thresholds;
  /** Areas verified as mutually distinct by the vision model (see pairStage). */
  verifiedDistinctAreas: number;
}): Required<StageInputs> {
  const { thresholds: t } = args;
  const byId = new Map(args.images.map((i) => [i.imageId, i]));
  const confirmed = args.pairs.filter((p) => isConfirmedPair(p, t.pairing));
  const pairedBefores = new Set(confirmed.map((p) => p.beforeId));

  const beforeImageIds = new Set<string>();
  for (const [imageId, s] of args.stages) {
    if (s.stage === "BEFORE" && (s.certainty === "STRONG" || pairedBefores.has(imageId))) beforeImageIds.add(imageId);
  }

  const beforeAfterEstablished = new Set<string>();
  const pairCounterEvidence: { service: string; item: EvidenceItem }[] = [];
  for (const service of args.services) {
    const rules = resolveServiceRules(args.registry, args.profile, service);
    const insufficientAlone = new Set(rules.definition.insufficient_alone);
    for (const p of confirmed) {
      const change = p.comparison!.changes.find((c) => c.service === service);
      if (!change) continue;
      const after = byId.get(p.afterId);
      if (!after) continue;

      if (change.direction === "IMPROVED" && change.strength >= t.confidence_bands.medium) {
        const afterSupports = after.observations.some(
          (o) => o.service === service && o.polarity === "positive" && !insufficientAlone.has(o.evidenceType) && o.strength >= t.confidence_bands.medium,
        );
        if (afterSupports) beforeAfterEstablished.add(service);
      } else if (change.direction !== "IMPROVED" && change.strength >= t.evidence.counter_evidence_min_strength) {
        pairCounterEvidence.push({
          service,
          item: {
            imageId: after.imageId,
            ref: after.ref,
            duplicateGroup: after.duplicateGroup,
            evidenceType: change.direction === "WORSENED" ? "before_after_worsened" : "before_after_no_visible_change",
            polarity: "negative",
            strength: change.strength,
            description: change.description,
            imagePairId: p.pairId,
          },
        });
      }
    }
  }

  return {
    beforeImageIds,
    beforeAfterEstablished,
    distinctScenes: args.verifiedDistinctAreas,
    pairCounterEvidence,
  };
}
