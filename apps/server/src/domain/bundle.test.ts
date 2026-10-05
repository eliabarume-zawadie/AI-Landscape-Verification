import { describe, expect, it } from "vitest";
import type { Thresholds } from "@alvip/shared";
import { loadVerificationConfigFromDir } from "../config/verificationConfig";
import { CONFIG_DIR } from "../test/helpers";
import { buildBundle, type BundleImage, type BundlePair } from "./bundle";
import type { EvidenceItem, ServiceAssessment } from "./evidence";

const base = loadVerificationConfigFromDir(CONFIG_DIR).thresholds;
const thresholds = (bundle: Partial<Thresholds["bundle"]> = {}): Thresholds => ({ ...base, bundle: { ...base.bundle, ...bundle } });

const img = (id: string, over: Partial<BundleImage> = {}): BundleImage => ({
  imageId: id,
  ref: id.toUpperCase(),
  usable: true,
  isRepresentative: true,
  duplicateGroup: id,
  qualityScore: 0.9,
  ...over,
});
const item = (imageId: string, strength = 0.9, over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  imageId,
  ref: imageId.toUpperCase(),
  duplicateGroup: imageId,
  evidenceType: "t",
  polarity: "positive",
  strength,
  description: "d",
  ...over,
});
const assessment = (service: string, over: Partial<ServiceAssessment> = {}): ServiceAssessment => ({
  service,
  status: "SUPPORTED",
  confidence: "HIGH",
  internalScore: 0.9,
  humanRequired: false,
  reasons: [],
  explanation: "",
  supporting: [],
  contradicting: [],
  context: [],
  contradictions: [],
  ...over,
});

describe("buildBundle — must-include evidence", () => {
  it("always includes both sides of a contradiction, even beyond the size cap", () => {
    const images = ["s1", "s2", "s3", "c1"].map((id) => img(id));
    const sup = [item("s1"), item("s2", 0.8), item("s3", 0.7)];
    const con = item("c1", 0.85, { polarity: "negative" });
    const b = buildBundle({
      assessments: [assessment("mowing", { status: "CONTRADICTORY", supporting: sup, contradicting: [con], contradictions: [{ supporting: sup[0]!, contradicting: con, description: "x" }] })],
      images,
      pairs: [],
      thresholds: thresholds({ max_images: 1 }),
    });
    const ids = b.entries.map((e) => e.imageId);
    expect(ids).toContain("c1");
    expect(ids).toContain("s1");
    expect(b.entries[0]!.reasons).toContain("CONTRADICTION");
    expect(b.mustIncludeCount).toBe(2);
  });

  it("always includes significant counter-evidence, but not weak counter-evidence", () => {
    const b = buildBundle({
      assessments: [assessment("edging", { status: "NOT_SUPPORTED", contradicting: [item("n1", 0.9, { polarity: "negative" }), item("n2", 0.3, { polarity: "negative" })] })],
      images: [img("n1"), img("n2")],
      pairs: [],
      thresholds: thresholds(),
    });
    expect(b.entries.map((e) => [e.imageId, e.reasons])).toEqual([["n1", ["COUNTER_EVIDENCE"]]]);
  });

  it("includes the before/after pair that established a service, with roles", () => {
    const pairs: BundlePair[] = [{ pairId: "p1", beforeId: "b1", afterId: "a1", confirmed: true, establishes: ["mowing"] }];
    const b = buildBundle({ assessments: [assessment("mowing", { supporting: [item("a1")] })], images: [img("b1"), img("a1")], pairs, thresholds: thresholds() });
    expect(b.byService[0]).toMatchObject({ imageIds: ["b1", "a1"], pairIds: ["p1"] });
    const roles = Object.fromEntries(b.entries.map((e) => [e.imageId, e.services.map((s) => s.role)]));
    expect(roles).toEqual({ b1: ["BEFORE"], a1: ["AFTER", "SUPPORTING"] });
  });
});

describe("buildBundle — strongest, diverse support", () => {
  it("takes the top N supporting images, one per duplicate cluster", () => {
    const sup = [item("d1", 0.95, { duplicateGroup: "g" }), item("d2", 0.94, { duplicateGroup: "g" }), item("x", 0.9), item("y", 0.8), item("z", 0.7)];
    const b = buildBundle({
      assessments: [assessment("mowing", { supporting: sup })],
      images: ["d1", "d2", "x", "y", "z"].map((id) => img(id, { duplicateGroup: id.startsWith("d") ? "g" : id })),
      pairs: [],
      thresholds: thresholds({ per_service_supporting: 3 }),
    });
    expect(b.byService[0]!.imageIds).toEqual(["d1", "x", "y"]);
  });

  it("prefers different areas before a second photo of the same area", () => {
    const pairs: BundlePair[] = [
      { pairId: "pA", beforeId: "bA", afterId: "a1", confirmed: true, establishes: [] },
      { pairId: "pA2", beforeId: "bA", afterId: "a2", confirmed: true, establishes: [] },
      { pairId: "pB", beforeId: "bB", afterId: "b1", confirmed: true, establishes: [] },
    ];
    const b = buildBundle({
      assessments: [assessment("mowing", { supporting: [item("a1", 0.95), item("a2", 0.94), item("b1", 0.8)] })],
      images: ["bA", "a1", "a2", "bB", "b1"].map((id) => img(id)),
      pairs,
      thresholds: thresholds({ per_service_supporting: 2 }),
    });
    expect(b.byService[0]!.imageIds).toEqual(["a1", "b1"]); // second area beats the 2nd-best of area A
  });

  it("never uses baseline (before-photo) items or unusable images as support", () => {
    const b = buildBundle({
      assessments: [assessment("mowing", { supporting: [item("base", 0.99, { baseline: true }), item("blurry", 0.98), item("ok", 0.8)] })],
      images: [img("base"), img("blurry", { usable: false }), img("ok")],
      pairs: [],
      thresholds: thresholds(),
    });
    expect(b.byService[0]!.imageIds).toEqual(["ok"]);
  });

  it("shows one context image when a service has no support", () => {
    const b = buildBundle({
      assessments: [assessment("mowing", { status: "INSUFFICIENT_EVIDENCE", context: [item("eq", 0.9, { polarity: "context" })] })],
      images: [img("eq")],
      pairs: [],
      thresholds: thresholds(),
    });
    expect(b.entries).toEqual([expect.objectContaining({ imageId: "eq", reasons: ["CONTEXT_ONLY"] })]);
  });

  it("lists an image once even when it serves several services", () => {
    const b = buildBundle({
      assessments: [assessment("mowing", { supporting: [item("x")] }), assessment("edging", { supporting: [item("x")] })],
      images: [img("x")],
      pairs: [],
      thresholds: thresholds(),
    });
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]!.services.map((s) => s.service).sort()).toEqual(["edging", "mowing"]);
  });

  it("trims only optional images to meet the cap", () => {
    const sup = ["s1", "s2", "s3"].map((id, i) => item(id, 0.9 - i * 0.05));
    const b = buildBundle({
      assessments: [assessment("mowing", { supporting: sup, contradicting: [item("c", 0.9, { polarity: "negative" })] })],
      images: ["s1", "s2", "s3", "c"].map((id) => img(id)),
      pairs: [],
      thresholds: thresholds({ max_images: 2 }),
    });
    expect(b.entries.map((e) => e.imageId)).toEqual(["c", "s1"]);
  });
});

describe("imageRanks (all images, strongest first)", () => {
  it("puts the bundle first, duplicates after their representative, unusable images last", () => {
    const b = buildBundle({
      assessments: [assessment("mowing", { supporting: [item("best", 0.95)] })],
      images: [img("blur", { usable: false }), img("dup", { isRepresentative: false, duplicateGroup: "best" }), img("plain"), img("best")],
      pairs: [],
      thresholds: thresholds(),
    });
    const order = [...b.imageRanks.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id);
    expect(order).toEqual(["best", "plain", "dup", "blur"]);
  });
});
