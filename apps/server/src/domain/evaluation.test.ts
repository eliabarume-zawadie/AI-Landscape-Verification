import { describe, expect, it } from "vitest";
import { computeMetrics, expectedForLocation, outcomeOf, predictFromRecommendation, predictFromStatus, summarize, wilson, type ScoredRow } from "./evaluation";

const row = (expected: "APPROVE" | "REJECT", predicted: "APPROVE" | "REJECT" | "NO_DECISION", extra: Partial<ScoredRow> = {}): ScoredRow => ({
  exampleId: "e",
  serviceCode: "mowing",
  expected,
  predicted,
  outcome: outcomeOf(expected, predicted),
  aiConfidence: "HIGH",
  clientName: "A",
  tags: [],
  imageQuality: "GOOD",
  reviewerDecision: null,
  ...extra,
});

describe("predictions and outcomes", () => {
  it("maps AI statuses; unclear statuses are the AI deferring, never a guess", () => {
    expect(predictFromStatus("SUPPORTED")).toBe("APPROVE");
    expect(predictFromStatus("CONTRADICTORY")).toBe("REJECT");
    expect(predictFromStatus("NOT_SUPPORTED")).toBe("REJECT");
    expect(predictFromStatus("INSUFFICIENT_EVIDENCE")).toBe("NO_DECISION");
    expect(predictFromStatus(null)).toBe("NO_DECISION");
    expect(predictFromRecommendation("NEEDS_HUMAN_REVIEW")).toBe("NO_DECISION");
  });
  it("classifies outcomes", () => {
    expect(outcomeOf("REJECT", "APPROVE")).toBe("FALSE_APPROVAL");
    expect(outcomeOf("APPROVE", "REJECT")).toBe("FALSE_REJECTION");
    expect(outcomeOf("APPROVE", "APPROVE")).toBe("CORRECT");
    expect(outcomeOf("REJECT", "NO_DECISION")).toBe("DEFERRED");
    expect(outcomeOf("REJECT", "APPROVE", true)).toBe("ERROR");
  });
  it("a location is approve only when every service is", () => {
    expect(expectedForLocation({ mowing: "APPROVE", edging: "APPROVE" })).toBe("APPROVE");
    expect(expectedForLocation({ mowing: "APPROVE", edging: "REJECT" })).toBe("REJECT");
  });
});

describe("wilson", () => {
  it("is wide for small samples and narrows with more data", () => {
    const small = wilson(0, 5)!;
    expect(small.low).toBe(0);
    expect(small.high).toBeGreaterThan(0.4);
    const large = wilson(0, 500)!;
    expect(large.high).toBeLessThan(0.01);
    expect(wilson(0, 0)).toBeNull();
  });
});

describe("computeMetrics", () => {
  it("computes the PRD §56 counts and rates", () => {
    const m = computeMetrics(
      [
        row("APPROVE", "APPROVE"),
        row("APPROVE", "APPROVE"),
        row("APPROVE", "REJECT"),
        row("APPROVE", "NO_DECISION"),
        row("REJECT", "REJECT"),
        row("REJECT", "APPROVE"),
        row("REJECT", "NO_DECISION"),
        { ...row("REJECT", "NO_DECISION"), outcome: "ERROR" },
      ],
      30,
    );
    expect(m).toMatchObject({ samples: 8, correct: 3, incorrect: 2, falseApprovals: 1, falseRejections: 1, deferred: 2, errors: 1, smallSample: true });
    expect(m.falseApprovalRate).toMatchObject({ k: 1, n: 3 }); // truth REJECT, excluding the error
    expect(m.falseRejectionRate).toMatchObject({ k: 1, n: 4 });
    expect(m.precision).toMatchObject({ k: 2, n: 3 });
    expect(m.recall).toMatchObject({ k: 2, n: 4 });
    expect(m.accuracyWhenDecided).toMatchObject({ k: 3, n: 5 });
    expect(m.deferralRate).toMatchObject({ k: 2, n: 7 });
  });
  it("counts human overrides where the historical reviewer disagreed with the AI's decision", () => {
    const m = computeMetrics([row("APPROVE", "REJECT", { reviewerDecision: "APPROVE" }), row("APPROVE", "APPROVE", { reviewerDecision: "APPROVE" }), row("REJECT", "NO_DECISION", { reviewerDecision: "REJECT" })], 1);
    expect(m.humanOverride).toBe(1);
  });
});

describe("summarize", () => {
  it("breaks down by service, client, tag, image quality and confidence, and reports missing coverage", () => {
    const s = summarize(
      [
        row("APPROVE", "APPROVE", { tags: ["CLEAR_APPROVAL"] }),
        row("REJECT", "APPROVE", { serviceCode: "edging", clientName: "B", tags: ["CONTRADICTION"], imageQuality: "POOR", aiConfidence: "LOW" }),
        row("REJECT", "APPROVE", { serviceCode: null, tags: ["CLEAR_APPROVAL"] }),
      ],
      30,
    );
    expect(Object.keys(s.byService)).toEqual(["edging", "mowing"]);
    expect(s.byClient.B!.falseApprovals).toBe(1);
    expect(s.byImageQuality.POOR!.falseApprovals).toBe(1);
    expect(s.byConfidence.LOW!.samples).toBe(1);
    expect(s.location.falseApprovals).toBe(1);
    expect(s.coverage.find((c) => c.tag === "CLEAR_APPROVAL")!.examples).toBe(1);
    expect(s.missingCoverage).toContain("MISSING_AFTER");
    expect(s.missingCoverage).not.toContain("CLEAR_APPROVAL");
  });
});
