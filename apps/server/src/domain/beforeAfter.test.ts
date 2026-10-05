import { describe, expect, it } from "vitest";
import { clientProfileSchema } from "@alvip/shared";
import { loadVerificationConfigFromDir } from "../config/verificationConfig";
import { CONFIG_DIR } from "../test/helpers";
import { deriveStageInputs, isConfirmedPair, type EvaluatedPair } from "./beforeAfter";
import type { EvidenceImage } from "./evidence";
import type { Observation, ServiceChange } from "./observations";
import { combinedDistance, pairCandidates, shiftedDistance, type PairableImage } from "./pairing";
import type { StageResult } from "./stageClassification";

const { registry, thresholds } = loadVerificationConfigFromDir(CONFIG_DIR);
const profile = clientProfileSchema.parse({ client: "T", display_name: "T" });

const obs = (service: string, evidenceType: string, strength = 0.9): Observation => ({
  service,
  evidenceType,
  polarity: registry.get(service).evidence_types.find((e) => e.type === evidenceType)!.polarity,
  strength,
  description: evidenceType,
});
const image = (imageId: string, observations: Observation[] = []): EvidenceImage => ({
  imageId,
  ref: imageId.toUpperCase(),
  ordinal: null,
  usable: true,
  isRepresentative: true,
  duplicateGroup: imageId,
  analysisStatus: "ANALYZED",
  observations,
  notAssessable: [],
});
const stage = (s: StageResult["stage"], certainty: StageResult["certainty"]): StageResult => ({
  stage: s,
  certainty,
  signals: { filename: null, time: null, conflict: false },
});
const pair = (beforeId: string, afterId: string, changes: ServiceChange[], over: Partial<NonNullable<EvaluatedPair["comparison"]>> = {}): EvaluatedPair => ({
  pairId: `${beforeId}-${afterId}`,
  beforeId,
  afterId,
  comparison: { sameArea: true, sameAreaConfidence: 0.95, comparisonPossible: true, changes, notes: "", ...over },
});
const improved = (service: string, strength = 0.9): ServiceChange => ({ service, direction: "IMPROVED", strength, description: "shorter grass" });

const derive = (images: EvidenceImage[], stages: [string, StageResult][], pairs: EvaluatedPair[], verifiedDistinctAreas = 1) =>
  deriveStageInputs({ images, stages: new Map(stages), pairs, services: ["mowing"], registry, profile, thresholds, verifiedDistinctAreas });

describe("isConfirmedPair", () => {
  it("needs same area, comparable, and enough confidence", () => {
    expect(isConfirmedPair(pair("b", "a", []), thresholds.pairing)).toBe(true);
    expect(isConfirmedPair(pair("b", "a", [], { sameArea: false }), thresholds.pairing)).toBe(false);
    expect(isConfirmedPair(pair("b", "a", [], { comparisonPossible: false }), thresholds.pairing)).toBe(false);
    expect(isConfirmedPair(pair("b", "a", [], { sameAreaConfidence: 0.5 }), thresholds.pairing)).toBe(false);
    expect(isConfirmedPair({ pairId: "x", beforeId: "b", afterId: "a", comparison: null }, thresholds.pairing)).toBe(false);
  });
});

describe("deriveStageInputs — baseline before-photos", () => {
  const imgs = [image("b"), image("a", [obs("mowing", "maintained_lawn")])];

  it("treats a STRONG before-photo as baseline even if unpaired", () => {
    expect(derive(imgs, [["b", stage("BEFORE", "STRONG")]], []).beforeImageIds).toEqual(new Set(["b"]));
  });

  it("treats a weakly labelled before-photo as baseline ONLY when in a confirmed pair", () => {
    expect(derive(imgs, [["b", stage("BEFORE", "SINGLE")]], []).beforeImageIds.size).toBe(0);
    expect(derive(imgs, [["b", stage("BEFORE", "SINGLE")]], [pair("b", "a", [])]).beforeImageIds).toEqual(new Set(["b"]));
  });

  it("never treats AFTER/UNKNOWN photos as baseline", () => {
    const r = derive(imgs, [["b", stage("UNKNOWN", "NONE")], ["a", stage("AFTER", "STRONG")]], [pair("b", "a", [])]);
    expect(r.beforeImageIds.size).toBe(0);
  });
});

describe("deriveStageInputs — before/after established (change is not proof)", () => {
  it("requires IMPROVED in a confirmed pair AND positive evidence in the after-photo", () => {
    const withSupport = [image("b"), image("a", [obs("mowing", "maintained_lawn")])];
    expect(derive(withSupport, [], [pair("b", "a", [improved("mowing")])]).beforeAfterEstablished).toEqual(new Set(["mowing"]));
  });

  it("is not established by visible change alone", () => {
    const noSupport = [image("b"), image("a", [obs("mowing", "equipment_present")])];
    expect(derive(noSupport, [], [pair("b", "a", [improved("mowing")])]).beforeAfterEstablished.size).toBe(0);
  });

  it("is not established by a weak change or an unconfirmed pair", () => {
    const imgs = [image("b"), image("a", [obs("mowing", "maintained_lawn")])];
    expect(derive(imgs, [], [pair("b", "a", [improved("mowing", 0.4)])]).beforeAfterEstablished.size).toBe(0);
    expect(derive(imgs, [], [pair("b", "a", [improved("mowing")], { sameArea: false })]).beforeAfterEstablished.size).toBe(0);
  });

  it("turns NO_VISIBLE_CHANGE / WORSENED into counter-evidence on the after-photo", () => {
    const imgs = [image("b"), image("a", [obs("mowing", "maintained_lawn")])];
    const r = derive(imgs, [], [pair("b", "a", [{ service: "mowing", direction: "NO_VISIBLE_CHANGE", strength: 0.85, description: "still long" }])]);
    expect(r.pairCounterEvidence).toHaveLength(1);
    expect(r.pairCounterEvidence[0]).toMatchObject({
      service: "mowing",
      item: { imageId: "a", polarity: "negative", evidenceType: "before_after_no_visible_change", imagePairId: "b-a" },
    });
    expect(r.beforeAfterEstablished.size).toBe(0);
  });

  it("passes through the verified distinct-area count", () => {
    expect(derive([], [], [], 2).distinctScenes).toBe(2);
  });
});

describe("pairing candidates", () => {
  const fp = (seed: number) => Uint8Array.from({ length: 1024 }, (_, i) => ((i * 7 + seed * 13) % 251) as number);
  const hist = (hot: number) => Uint8Array.from({ length: 64 }, (_, i) => (i === hot ? 255 : 0));
  const img = (id: string, seed: number, hot: number): PairableImage => ({ imageId: id, ref: id, fingerprint: fp(seed), colorHist: hist(hot) });

  it("scores identical thumbnails as distance 0 and is shift tolerant", () => {
    const a = fp(1);
    expect(shiftedDistance(a, a)).toBe(0);
    const shifted = Uint8Array.from({ length: 1024 }, (_, i) => a[(i + 1) % 1024]!);
    expect(shiftedDistance(a, shifted)).toBeLessThan(shiftedDistance(a, fp(9)));
  });

  it("returns infinity when data is missing (never a confident match)", () => {
    expect(combinedDistance({ imageId: "x", ref: "x", fingerprint: null, colorHist: null }, img("y", 1, 1), 0.02)).toBe(Infinity);
  });

  it("checks every combination for small locations, top-K for large ones, best first", () => {
    const befores = [img("b1", 1, 3)];
    const afters = [img("a-far", 9, 40), img("a-near", 1, 3), img("a-mid", 5, 3)];
    const all = pairCandidates(befores, afters, thresholds.pairing);
    expect(all.map((c) => c.afterId)).toEqual(["a-near", "a-mid", "a-far"]);
    const top = pairCandidates(befores, afters, { ...thresholds.pairing, max_full_pairs: 1, candidates_per_before: 1 });
    expect(top.map((c) => c.afterId)).toEqual(["a-near"]);
  });
});
