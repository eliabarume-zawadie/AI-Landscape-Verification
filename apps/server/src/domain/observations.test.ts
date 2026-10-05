import { describe, expect, it } from "vitest";
import { loadVerificationConfigFromDir } from "../config/verificationConfig";
import { CONFIG_DIR } from "../test/helpers";
import { imageAnalysisJsonSchema, validateAreaCheck, validateImageAnalysis, validatePairComparison } from "./observations";

const { registry } = loadVerificationConfigFromDir(CONFIG_DIR);
const ctx = { registry, requestedServices: ["mowing", "edging", "landscape_fertilization"] };

const obs = (service: string, evidence_type: string, strength = 0.9, description = "visible") => ({
  service,
  evidence_type,
  strength,
  description,
});
const output = (over: Record<string, unknown> = {}) => ({
  image_relevant: true,
  visibility_issues: [],
  scene_summary: "Front lawn after service.",
  observations: [obs("mowing", "maintained_lawn")],
  not_assessable: [],
  ...over,
});

describe("validateImageAnalysis", () => {
  it("accepts a well-formed response and assigns polarity from the registry", () => {
    const r = validateImageAnalysis(
      output({ observations: [obs("mowing", "maintained_lawn"), obs("mowing", "equipment_present"), obs("mowing", "uncut_section_visible")] }),
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.observations.map((o) => [o.evidenceType, o.polarity])).toEqual([
      ["maintained_lawn", "positive"],
      ["equipment_present", "context"],
      ["uncut_section_visible", "negative"],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("parses JSON text responses", () => {
    expect(validateImageAnalysis(JSON.stringify(output()), ctx).ok).toBe(true);
  });

  it("rejects malformed responses as a whole", () => {
    expect(validateImageAnalysis("Sure! The lawn looks great.", ctx).ok).toBe(false);
    expect(validateImageAnalysis('{"image_relevant": true, "observations": [', ctx).ok).toBe(false);
    expect(validateImageAnalysis({ image_relevant: true }, ctx).ok).toBe(false);
    expect(validateImageAnalysis(null, ctx).ok).toBe(false);
  });

  it("drops hallucinated evidence types instead of trusting them", () => {
    const r = validateImageAnalysis(output({ observations: [obs("mowing", "service_definitely_completed", 0.99)] }), ctx);
    expect(r.ok && r.value.observations).toEqual([]);
    expect(r.ok && r.warnings[0]).toMatch(/evidence type not defined/);
  });

  it("drops evidence types that belong to a different service", () => {
    const r = validateImageAnalysis(output({ observations: [obs("mowing", "defined_lawn_boundary")] }), ctx);
    expect(r.ok && r.value.observations).toEqual([]);
  });

  it("drops services that were not requested", () => {
    const r = validateImageAnalysis(output({ observations: [obs("shrub_pruning", "shrubs_shaped_uniform")] }), ctx);
    expect(r.ok && r.value.observations).toEqual([]);
    expect(r.ok && r.warnings[0]).toMatch(/not requested/);
  });

  it("drops out-of-range strengths and empty descriptions", () => {
    const r = validateImageAnalysis(output({ observations: [obs("mowing", "maintained_lawn", 1.7), obs("edging", "fresh_edge_line", 0.8, "  ")] }), ctx);
    expect(r.ok && r.value.observations).toEqual([]);
    expect(r.ok && r.warnings).toHaveLength(2);
  });

  it("never keeps evidence for an image the model marked irrelevant", () => {
    const r = validateImageAnalysis(output({ image_relevant: false }), ctx);
    expect(r.ok && r.value.observations).toEqual([]);
    expect(r.ok && r.value.visibilityIssues).toContain("IRRELEVANT");
  });

  it("keeps the strongest of duplicate observations", () => {
    const r = validateImageAnalysis(output({ observations: [obs("mowing", "maintained_lawn", 0.4), obs("mowing", "maintained_lawn", 0.8)] }), ctx);
    expect(r.ok && r.value.observations.map((o) => o.strength)).toEqual([0.8]);
  });

  it("treats healthy grass as context only for fertilization", () => {
    const r = validateImageAnalysis(output({ observations: [obs("landscape_fertilization", "healthy_lawn_appearance", 0.95)] }), ctx);
    expect(r.ok && r.value.observations[0]!.polarity).toBe("context");
  });
});

describe("imageAnalysisJsonSchema", () => {
  it("restricts services and evidence types to the request", () => {
    const schema = imageAnalysisJsonSchema(registry, ["mowing"]) as {
      properties: { observations: { items: { properties: { service: { enum: string[] }; evidence_type: { enum: string[] } } } } };
      additionalProperties: boolean;
    };
    const items = schema.properties.observations.items.properties;
    expect(items.service.enum).toEqual(["mowing"]);
    expect(items.evidence_type.enum).toContain("uncut_section_visible");
    expect(items.evidence_type.enum).not.toContain("defined_lawn_boundary");
    expect(schema.additionalProperties).toBe(false);
  });

  it("has no field for a status, decision, or approval", () => {
    const text = JSON.stringify(imageAnalysisJsonSchema(registry, ["mowing", "edging"]));
    for (const forbidden of ["status", "approve", "decision", "recommend", "confidence"]) expect(text).not.toContain(forbidden);
  });
});

describe("validatePairComparison", () => {
  const pairOut = (over: Record<string, unknown> = {}) => ({
    same_area: true,
    same_area_confidence: 0.9,
    comparison_possible: true,
    changes: [{ service: "mowing", direction: "IMPROVED", strength: 0.9, description: "grass shorter" }],
    notes: "same fence and path",
    ...over,
  });

  it("accepts a valid comparison", () => {
    const r = validatePairComparison(pairOut(), { requestedServices: ["mowing"] });
    expect(r.ok && r.value).toMatchObject({ sameArea: true, changes: [{ service: "mowing", direction: "IMPROVED" }] });
  });

  it("drops changes for a different-area or non-comparable pair", () => {
    for (const over of [{ same_area: false }, { comparison_possible: false }]) {
      const r = validatePairComparison(pairOut(over), { requestedServices: ["mowing"] });
      expect(r.ok && r.value.changes).toEqual([]);
    }
  });

  it("drops unrequested services and bad strengths; rejects bad structure", () => {
    const r = validatePairComparison(
      pairOut({ changes: [{ service: "edging", direction: "IMPROVED", strength: 0.9, description: "x" }, { service: "mowing", direction: "IMPROVED", strength: 3, description: "x" }] }),
      { requestedServices: ["mowing"] },
    );
    expect(r.ok && r.value.changes).toEqual([]);
    expect(validatePairComparison(pairOut({ same_area_confidence: 7 }), { requestedServices: [] }).ok).toBe(false);
    expect(validatePairComparison({ same_area: true }, { requestedServices: [] }).ok).toBe(false);
    expect(validatePairComparison(pairOut({ changes: [{ service: "mowing", direction: "DONE", strength: 0.9, description: "x" }] }), { requestedServices: ["mowing"] }).ok).toBe(false);
  });
});

describe("validateAreaCheck", () => {
  it("accepts a well-formed answer and rejects malformed ones", () => {
    expect(validateAreaCheck({ same_area: false, same_area_confidence: 0.9, notes: "different buildings" })).toMatchObject({ ok: true });
    expect(validateAreaCheck({ same_area: false, same_area_confidence: 1.5, notes: "" }).ok).toBe(false);
    expect(validateAreaCheck("nope").ok).toBe(false);
  });
});
