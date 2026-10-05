import { describe, expect, it } from "vitest";
import { loadVerificationConfigFromDir } from "../config/verificationConfig";
import { CONFIG_DIR } from "../test/helpers";
import type { ServiceAssessment } from "./evidence";
import { assessRisk, chooseLane, recommend, type RiskImageStats, type RiskInput } from "./risk";

const { thresholds } = loadVerificationConfigFromDir(CONFIG_DIR);

const svc = (service: string, over: Partial<ServiceAssessment> = {}): ServiceAssessment => ({
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
const images = (over: Partial<RiskImageStats> = {}): RiskImageStats => ({
  total: 10,
  readable: 10,
  usable: 10,
  duplicates: 0,
  unusualScene: 0,
  analysisFailures: 0,
  ...over,
});
const input = (assessments: ServiceAssessment[], over: Partial<RiskInput> = {}): RiskInput => ({
  assessments,
  images: images(),
  servicesRequiringBeforeAfter: [],
  clientRequiresHumanReview: false,
  thresholds,
  ...over,
});
const factors = (r: ReturnType<typeof assessRisk>) => r.factors.map((f) => f.factor);

describe("assessRisk (PRD §24)", () => {
  it("is LOW with no factors", () => {
    expect(assessRisk(input([svc("mowing"), svc("edging")]))).toMatchObject({ level: "LOW", factors: [] });
  });

  it("forces HIGH for a contradiction and for 'unable to determine'", () => {
    expect(assessRisk(input([svc("mowing", { status: "CONTRADICTORY" })])).level).toBe("HIGH");
    expect(assessRisk(input([svc("mowing", { status: "UNABLE_TO_DETERMINE" })])).level).toBe("HIGH");
  });

  it("forces at least MEDIUM for insufficient / not supported / client rules / failed analyses", () => {
    expect(assessRisk(input([svc("mowing", { status: "INSUFFICIENT_EVIDENCE" })])).level).toBe("MEDIUM");
    expect(assessRisk(input([svc("mowing", { status: "NOT_SUPPORTED" })])).level).toBe("MEDIUM");
    expect(assessRisk(input([svc("mowing")], { clientRequiresHumanReview: true })).level).toBe("MEDIUM");
    expect(assessRisk(input([svc("mowing", { reasons: ["RULE_REQUIRES_HUMAN_REVIEW"] })])).level).toBe("MEDIUM");
    expect(assessRisk(input([svc("mowing")], { images: images({ analysisFailures: 1 }) })).level).toBe("MEDIUM");
  });

  it("adds image-based factors by ratio", () => {
    const r = assessRisk(input([svc("mowing")], { images: images({ usable: 6, duplicates: 6, unusualScene: 4 }) }));
    expect(factors(r)).toEqual(expect.arrayContaining(["POOR_IMAGE_QUALITY", "DUPLICATE_HEAVY", "UNUSUAL_SCENE"]));
    expect(r.level).toBe("MEDIUM"); // 0.2 + 0.15 + 0.2 = 0.55
  });

  it("flags missing before/after only for services that require it", () => {
    const a = svc("mowing", { status: "INSUFFICIENT_EVIDENCE", reasons: ["BEFORE_AFTER_NOT_ESTABLISHED"] });
    expect(factors(assessRisk(input([a], { servicesRequiringBeforeAfter: ["mowing"] })))).toContain("MISSING_BEFORE_AFTER");
    expect(factors(assessRisk(input([a], { servicesRequiringBeforeAfter: [] })))).not.toContain("MISSING_BEFORE_AFTER");
  });

  it("flags conflicting outcomes across services and low confidence", () => {
    const r = assessRisk(input([svc("mowing", { confidence: "MEDIUM" }), svc("edging", { status: "NOT_SUPPORTED" })]));
    expect(factors(r)).toEqual(expect.arrayContaining(["CONFLICTING_SERVICE_OUTCOMES", "LOW_CONFIDENCE", "NOT_SUPPORTED"]));
  });

  it("escalates by score: several mid-weight factors reach HIGH", () => {
    const r = assessRisk(
      input([svc("mowing", { status: "INSUFFICIENT_EVIDENCE", reasons: ["BEFORE_AFTER_NOT_ESTABLISHED"] })], { servicesRequiringBeforeAfter: ["mowing"] }),
    );
    expect(r.internalScore).toBeCloseTo(0.7);
    expect(r.level).toBe("HIGH");
  });

  it("explains each factor in plain language and orders by weight", () => {
    const r = assessRisk(input([svc("mowing", { status: "CONTRADICTORY" }), svc("edging", { confidence: "MEDIUM" })]));
    expect(r.factors[0]).toMatchObject({ factor: "CONTRADICTION", detail: "Contradictory evidence for mowing" });
  });
});

describe("recommend", () => {
  const low = assessRisk(input([svc("mowing")]));

  it("recommends approval only when everything is strong, unflagged and low risk", () => {
    expect(recommend([svc("mowing"), svc("edging")], low).recommendation).toBe("RECOMMEND_APPROVE");
  });

  it("does not recommend approval when any service is flagged for a human", () => {
    const flagged = [svc("mowing"), svc("shrub_pruning", { confidence: "MEDIUM", humanRequired: true })];
    const r = recommend(flagged, assessRisk(input(flagged)));
    expect(r.recommendation).toBe("NEEDS_HUMAN_REVIEW");
  });

  it("does not recommend approval when a client rule requires review, even if all supported", () => {
    const r = assessRisk(input([svc("mowing")], { clientRequiresHumanReview: true }));
    expect(recommend([svc("mowing")], r).recommendation).toBe("NEEDS_HUMAN_REVIEW");
  });

  it("recommends rejection when evidence does not support a service (and nothing is unclear)", () => {
    const a = [svc("mowing"), svc("edging", { status: "NOT_SUPPORTED", humanRequired: true })];
    const r = recommend(a, assessRisk(input(a)));
    expect(r).toEqual({ recommendation: "RECOMMEND_REJECT", explanation: "The evidence does not support: edging." });
  });

  it("never recommends rejection when something is contradictory or undetermined", () => {
    const a = [svc("mowing", { status: "CONTRADICTORY" }), svc("edging", { status: "NOT_SUPPORTED" })];
    expect(recommend(a, assessRisk(input(a))).recommendation).toBe("NEEDS_HUMAN_REVIEW");
  });

  it("explains why a human is needed", () => {
    const a = [svc("mowing", { status: "CONTRADICTORY" })];
    expect(recommend(a, assessRisk(input(a))).explanation).toMatch(/contradictory evidence for mowing/);
  });
});

describe("chooseLane (PRD §36, §53)", () => {
  const ok = { recommendation: "RECOMMEND_APPROVE" as const, risk: "LOW" as const, shadowMode: false };
  it("uses the Fast Lane only at automation level 3+ for a low-risk approve recommendation", () => {
    expect(chooseLane({ ...ok, automationLevel: 3 })).toBe("FAST");
    for (const level of [0, 1, 2]) expect(chooseLane({ ...ok, automationLevel: level })).toBe("HUMAN_REVIEW");
  });
  it("never uses the Fast Lane in shadow mode, for medium risk, or without an approve recommendation", () => {
    expect(chooseLane({ ...ok, automationLevel: 3, shadowMode: true })).toBe("HUMAN_REVIEW");
    expect(chooseLane({ ...ok, automationLevel: 3, risk: "MEDIUM" })).toBe("HUMAN_REVIEW");
    expect(chooseLane({ ...ok, automationLevel: 3, recommendation: "NEEDS_HUMAN_REVIEW" })).toBe("HUMAN_REVIEW");
  });
});
