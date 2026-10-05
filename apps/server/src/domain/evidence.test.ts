import { describe, expect, it } from "vitest";
import { clientProfileSchema, type ClientProfile } from "@alvip/shared";
import { loadVerificationConfigFromDir } from "../config/verificationConfig";
import { CONFIG_DIR } from "../test/helpers";
import { assessService, eligibleImages, type EvidenceContext, type EvidenceImage, type StageInputs } from "./evidence";
import type { Observation } from "./observations";

const { registry, thresholds } = loadVerificationConfigFromDir(CONFIG_DIR);

/** Profile with no extra requirements, so tests isolate one rule at a time. */
const plain = (over: Partial<ClientProfile> = {}) =>
  clientProfileSchema.parse({ client: "T", display_name: "T", before_after_required: false, ...over });

const ALL_DONE: StageInputs = { beforeAfterEstablished: new Set(["mowing", "edging", "weed_removal", "trash_debris_leaves_removal"]), distinctScenes: 10 };

let n = 0;
function img(observations: [service: string, type: string, strength?: number][], over: Partial<EvidenceImage> = {}): EvidenceImage {
  n++;
  const id = `img-${n}`;
  return {
    imageId: id,
    ref: `IMG${String(n).padStart(3, "0")}`,
    ordinal: n,
    usable: true,
    isRepresentative: true,
    duplicateGroup: id,
    analysisStatus: "ANALYZED",
    observations: observations.map(([service, evidenceType, strength = 0.9]): Observation => {
      const polarity = registry.get(service).evidence_types.find((e) => e.type === evidenceType)!.polarity;
      return { service, evidenceType, polarity, strength, description: `${evidenceType} visible` };
    }),
    notAssessable: [],
    ...over,
  };
}
const ctx = (images: EvidenceImage[], over: Partial<EvidenceContext> = {}): EvidenceContext => ({
  registry,
  profile: plain(),
  thresholds,
  images,
  stage: ALL_DONE,
  ...over,
});

describe("eligibility", () => {
  it("only counts analysed, usable, representative images", () => {
    const imgs = [
      img([["mowing", "maintained_lawn"]]),
      img([["mowing", "maintained_lawn"]], { usable: false }),
      img([["mowing", "maintained_lawn"]], { isRepresentative: false }),
      img([["mowing", "maintained_lawn"]], { analysisStatus: "MALFORMED" }),
      img([["mowing", "maintained_lawn"]], { analysisStatus: "CACHED" }),
    ];
    expect(eligibleImages(imgs).map((i) => i.ref)).toEqual([imgs[0]!.ref, imgs[4]!.ref]);
  });
});

describe("SUPPORTED", () => {
  it("requires strong qualifying evidence; HIGH needs two independent images", () => {
    const one = assessService(ctx([img([["mowing", "maintained_lawn", 0.95]])]), "mowing");
    expect(one).toMatchObject({ status: "SUPPORTED", confidence: "MEDIUM", humanRequired: true });
    expect(one.reasons).toContain("SINGLE_INDEPENDENT_IMAGE");

    const two = assessService(ctx([img([["mowing", "maintained_lawn", 0.95]]), img([["mowing", "fresh_mow_pattern", 0.9]])]), "mowing");
    expect(two).toMatchObject({ status: "SUPPORTED", confidence: "HIGH", humanRequired: false });
    expect(two.explanation).toMatch(/Mowing is supported: 2 independent image\(s\)/);
  });

  it("does not let duplicates of one photo raise confidence (PRD §15)", () => {
    const group = "cluster-A";
    const dupes = Array.from({ length: 25 }, () => img([["mowing", "maintained_lawn", 0.95]], { duplicateGroup: group }));
    const r = assessService(ctx(dupes), "mowing");
    expect(r.confidence).toBe("MEDIUM");
    expect(r.reasons).toContain("SINGLE_INDEPENDENT_IMAGE");
  });

  it("flags weak counter-evidence and requires human review", () => {
    const r = assessService(
      ctx([img([["mowing", "maintained_lawn", 0.95]]), img([["mowing", "fresh_mow_pattern", 0.9], ["mowing", "uncut_section_visible", 0.3]])]),
      "mowing",
    );
    expect(r.status).toBe("SUPPORTED");
    expect(r.reasons).toContain("WEAK_COUNTER_EVIDENCE");
    expect(r.humanRequired).toBe(true);
  });
});

describe("never SUPPORTED from context alone (PRD §28, §60)", () => {
  it("equipment does not prove mowing", () => {
    const r = assessService(ctx([img([["mowing", "equipment_present", 0.99]]), img([["mowing", "equipment_present", 0.99]])]), "mowing");
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasons).toContain("ONLY_CONTEXT_EVIDENCE");
    expect(r.explanation).toMatch(/cannot prove the service/);
  });

  it("healthy grass does not prove fertilization, and fertilization always needs a human", () => {
    const r = assessService(
      ctx([img([["landscape_fertilization", "healthy_lawn_appearance", 0.99]]), img([["landscape_fertilization", "healthy_lawn_appearance", 0.99]])]),
      "landscape_fertilization",
    );
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.humanRequired).toBe(true);
    expect(r.reasons).toContain("RULE_REQUIRES_HUMAN_REVIEW");
  });

  it("'weeds reduced' does not prove weed removal", () => {
    const r = assessService(ctx([img([["weed_removal", "weeds_reduced", 0.95]]), img([["weed_removal", "weeds_reduced", 0.95]])]), "weed_removal");
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("observed dead grass is not the service being addressed", () => {
    const r = assessService(ctx([img([["dead_brown_grass", "dead_brown_grass_observed", 0.95]])]), "dead_brown_grass");
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("CONTRADICTORY and NOT_SUPPORTED", () => {
  it("strong support plus strong counter-evidence is contradictory (demo case 4)", () => {
    const yes = img([["mowing", "maintained_lawn", 0.9]]);
    const no = img([["mowing", "uncut_section_visible", 0.85]]);
    const r = assessService(ctx([yes, no]), "mowing");
    expect(r).toMatchObject({ status: "CONTRADICTORY", confidence: "LOW", humanRequired: true });
    expect(r.contradictions).toHaveLength(1);
    expect(r.contradictions[0]!.description).toBe(`${yes.ref} shows maintained lawn, but ${no.ref} shows uncut section visible.`);
  });

  it("negative evidence with no support is NOT_SUPPORTED", () => {
    const r = assessService(ctx([img([["edging", "grass_overgrowing_hardscape", 0.9]]), img([["edging", "grass_overgrowing_hardscape", 0.88]])]), "edging");
    expect(r).toMatchObject({ status: "NOT_SUPPORTED", confidence: "HIGH" });
    expect(r.explanation).toMatch(/no image shows the work completed/);
  });
});

describe("INSUFFICIENT_EVIDENCE vs UNABLE_TO_DETERMINE", () => {
  it("absence of evidence is insufficient, never NOT_SUPPORTED", () => {
    const r = assessService(ctx([img([["edging", "defined_lawn_boundary"]])]), "mowing");
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasons).toContain("NO_RELEVANT_EVIDENCE");
  });

  it("weak positive evidence is below threshold", () => {
    const r = assessService(ctx([img([["mowing", "maintained_lawn", 0.7]]), img([["mowing", "maintained_lawn", 0.7]])]), "mowing");
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasons).toContain("BELOW_CONFIDENCE_THRESHOLD");
  });

  it("all images unusable → insufficient (demo case 5 style)", () => {
    const r = assessService(ctx([img([["mowing", "maintained_lawn"]], { usable: false })]), "mowing");
    expect(r.reasons).toContain("NO_USABLE_ANALYSED_IMAGES");
  });

  it("AI failed on every usable image → unable to determine", () => {
    const r = assessService(ctx([img([], { analysisStatus: "MALFORMED" }), img([], { analysisStatus: "REFUSED" })]), "mowing");
    expect(r.status).toBe("UNABLE_TO_DETERMINE");
    expect(r.explanation).toMatch(/could not analyse 2 usable image/);
  });

  it("some failed analyses force human review even when supported", () => {
    const r = assessService(
      ctx([img([["mowing", "maintained_lawn", 0.95]]), img([["mowing", "fresh_mow_pattern", 0.95]]), img([], { analysisStatus: "MALFORMED" })]),
      "mowing",
    );
    expect(r.status).toBe("SUPPORTED");
    expect(r.reasons).toContain("SOME_IMAGES_NOT_ANALYSED");
    expect(r.humanRequired).toBe(true);
  });
});

describe("requirements fail closed until evaluated", () => {
  const strong = () => [img([["mowing", "maintained_lawn", 0.95]]), img([["mowing", "fresh_mow_pattern", 0.95]])];

  it("before/after required but not yet evaluated → insufficient", () => {
    const r = assessService(ctx(strong(), { profile: plain({ before_after_required: true }), stage: {} }), "mowing");
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasons).toContain("BEFORE_AFTER_NOT_YET_EVALUATED");
    expect(r.explanation).toMatch(/before\/after evidence, which has not been evaluated yet/);
  });

  it("before/after evaluated but not established → insufficient", () => {
    const r = assessService(
      ctx(strong(), { profile: plain({ before_after_required: true }), stage: { beforeAfterEstablished: new Set(), distinctScenes: 5 } }),
      "mowing",
    );
    expect(r.reasons).toContain("BEFORE_AFTER_NOT_ESTABLISHED");
  });

  it("client minimum usable images", () => {
    const r = assessService(ctx(strong(), { profile: plain({ image_requirements: { min_usable_images: 3 } }) }), "mowing");
    expect(r.reasons).toContain("MIN_USABLE_IMAGES_NOT_MET");
  });

  it("client distinct-scene coverage, unevaluated and unmet", () => {
    const req = plain({ image_requirements: { min_distinct_scenes: 2 } });
    expect(assessService(ctx(strong(), { profile: req, stage: { beforeAfterEstablished: new Set() } }), "mowing").reasons).toContain(
      "SCENE_COVERAGE_NOT_YET_EVALUATED",
    );
    expect(assessService(ctx(strong(), { profile: req, stage: { ...ALL_DONE, distinctScenes: 1 } }), "mowing").reasons).toContain(
      "MIN_DISTINCT_SCENES_NOT_MET",
    );
  });
});

describe("landscape maintenance (decomposed, PRD §63)", () => {
  const profile = plain({ service_overrides: { landscape_maintenance: { required_components: ["mowing", "edging"] } } });

  it("is supported only when every required component is", () => {
    const imgs = [
      img([["mowing", "maintained_lawn", 0.95], ["edging", "defined_lawn_boundary", 0.95]]),
      img([["mowing", "fresh_mow_pattern", 0.95], ["edging", "fresh_edge_line", 0.95]]),
    ];
    const r = assessService(ctx(imgs, { profile }), "landscape_maintenance");
    expect(r).toMatchObject({ status: "SUPPORTED", components: { mowing: "SUPPORTED", edging: "SUPPORTED" } });
  });

  it("takes the most severe component status", () => {
    const imgs = [img([["mowing", "maintained_lawn", 0.95]]), img([["mowing", "fresh_mow_pattern", 0.95]])];
    const r = assessService(ctx(imgs, { profile }), "landscape_maintenance");
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.reasons).toContain("COMPONENT_EDGING_INSUFFICIENT_EVIDENCE");
  });

  it("a nice-looking property alone does not support it", () => {
    const imgs = [img([["landscape_maintenance", "overall_maintained_appearance", 0.99]]), img([["landscape_maintenance", "overall_maintained_appearance", 0.99]])];
    expect(assessService(ctx(imgs, { profile }), "landscape_maintenance").status).not.toBe("SUPPORTED");
  });

  it("its own negative evidence can make it contradictory", () => {
    const imgs = [
      img([["mowing", "maintained_lawn", 0.95], ["edging", "defined_lawn_boundary", 0.95]]),
      img([["mowing", "fresh_mow_pattern", 0.95], ["edging", "fresh_edge_line", 0.95], ["landscape_maintenance", "plant_bed_maintained", 0.9]]),
      img([["landscape_maintenance", "plant_bed_unmaintained", 0.9]]),
    ];
    const r = assessService(ctx(imgs, { profile }), "landscape_maintenance");
    expect(r.status).toBe("CONTRADICTORY");
    expect(r.contradictions.length).toBeGreaterThan(0);
  });
});

describe("before photos (input from Phase 6)", () => {
  const before = () => img([["mowing", "tall_overgrown_grass", 0.9]]);
  const afters = () => [img([["mowing", "maintained_lawn", 0.95]]), img([["mowing", "fresh_mow_pattern", 0.95]])];

  it("without before/after knowledge, a before photo's negative evidence contradicts (conservative)", () => {
    expect(assessService(ctx([before(), ...afters()]), "mowing").status).toBe("CONTRADICTORY");
  });

  it("once identified as a before photo, its negative evidence is baseline context", () => {
    const b = before();
    const r = assessService(ctx([b, ...afters()], { stage: { ...ALL_DONE, beforeImageIds: new Set([b.imageId]) } }), "mowing");
    expect(r.status).toBe("SUPPORTED");
    expect(r.context.find((c) => c.imageId === b.imageId)).toMatchObject({ baseline: true, evidenceType: "tall_overgrown_grass" });
    expect(r.contradicting).toEqual([]);
  });

  it("a before photo cannot be supporting evidence", () => {
    const b = img([["mowing", "maintained_lawn", 0.99]]);
    const r = assessService(ctx([b], { stage: { ...ALL_DONE, beforeImageIds: new Set([b.imageId]) } }), "mowing");
    expect(r.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("negative evidence in an AFTER photo still contradicts", () => {
    const b = before();
    const r = assessService(
      ctx([b, ...afters(), img([["mowing", "uncut_section_visible", 0.85]])], { stage: { ...ALL_DONE, beforeImageIds: new Set([b.imageId]) } }),
      "mowing",
    );
    expect(r.status).toBe("CONTRADICTORY");
  });
});

describe("determinism", () => {
  it("gives identical results for identical input", () => {
    const imgs = [img([["mowing", "maintained_lawn", 0.9]]), img([["mowing", "uncut_section_visible", 0.85]])];
    expect(assessService(ctx(imgs), "mowing")).toEqual(assessService(ctx(imgs), "mowing"));
  });
});
