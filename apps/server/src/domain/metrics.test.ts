import { describe, expect, it } from "vitest";
import { agreementCounts, confidenceAgreement, diagnose, median, percentile, rate, type QueueSnapshot, type ReviewFact } from "./metrics";

const fact = (decision: ReviewFact["decision"], aiRecommendation: string | null, services: Record<string, [string, string]> = {}, split: Record<string, string> = {}): ReviewFact => ({
  decision,
  aiRecommendation,
  isOverride: false,
  aiServices: Object.fromEntries(Object.entries(services).map(([k, [status, confidence]]) => [k, { status, confidence }])),
  serviceDecisions: split,
});

describe("rate", () => {
  it("suppresses rates below the minimum sample instead of showing a misleading percentage", () => {
    expect(rate(3, 4, 30)).toEqual({ value: null, numerator: 3, denominator: 4, suppressed: true });
    expect(rate(15, 30, 30)).toEqual({ value: 0.5, numerator: 15, denominator: 30, suppressed: false });
    expect(rate(0, 0, 0).value).toBeNull();
  });
});

describe("median / percentile", () => {
  it("handles odd, even and empty inputs", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
  });
});

describe("agreementCounts", () => {
  it("counts agreement only where the AI gave an opinion; deferrals and escalations are separate", () => {
    const c = agreementCounts([
      fact("APPROVE", "RECOMMEND_APPROVE"),
      fact("REJECT", "RECOMMEND_APPROVE"),
      fact("REJECT", "RECOMMEND_REJECT"),
      fact("APPROVE", "RECOMMEND_REJECT"),
      fact("APPROVE", "NEEDS_HUMAN_REVIEW"),
      fact("ESCALATE", "RECOMMEND_APPROVE"),
      fact("APPROVE", null),
    ]);
    expect(c).toEqual({ agree: 2, opinions: 4, deferred: 1, approveSuggested: 2, approveSuggestedRejected: 1, rejectSuggested: 2, rejectSuggestedApproved: 1 });
  });
});

describe("confidenceAgreement", () => {
  it("compares per-service AI verdicts with the human decision per confidence band", () => {
    const c = confidenceAgreement([
      fact("APPROVE", null, { mowing: ["SUPPORTED", "HIGH"], edging: ["SUPPORTED", "MEDIUM"] }),
      fact("REJECT", null, { mowing: ["SUPPORTED", "HIGH"] }),
      fact("REJECT", null, { mowing: ["CONTRADICTORY", "LOW"], weeds: ["INSUFFICIENT_EVIDENCE", "LOW"] }),
      fact("APPROVE", null, { mowing: ["NOT_SUPPORTED", "MEDIUM"] }, { mowing: "REJECT" }),
    ]);
    expect(c).toEqual({ HIGH: { agree: 1, total: 2 }, MEDIUM: { agree: 2, total: 2 }, LOW: { agree: 1, total: 1 } });
  });
});

describe("diagnose", () => {
  const base: QueueSnapshot = {
    awaitingReview: 0,
    oldestAwaitingMinutes: null,
    inProgress: 0,
    oldestUnprocessedMinutes: null,
    errorsByStatus: {},
    waitingForNetSuite: 0,
    netsuiteStopped: 0,
    pendingJobs: 0,
    minutesSinceLastJobFinished: 2,
    recentErrorsByCategory: {},
    decidedToday: 12,
    remaining: 0,
  };
  it("says the queue is clear when nothing waits", () => {
    expect(diagnose(base)).toEqual([{ level: "ok", text: "Queue is clear: 12 locations decided and nothing waiting." }]);
  });
  it("explains why the queue is not clearing, most important first", () => {
    const d = diagnose({
      ...base,
      pendingJobs: 4,
      minutesSinceLastJobFinished: 25,
      awaitingReview: 21,
      oldestAwaitingMinutes: 9 * 60,
      errorsByStatus: { AI_ERROR: 3, IMAGE_ERROR: 1 },
      netsuiteStopped: 2,
      recentErrorsByCategory: { AUTHENTICATION: 1 },
    });
    expect(d.map((x) => x.level)).toEqual(["warn", "warn", "warn", "warn", "info", "warn"]);
    expect(d[0]!.text).toBe("Processing looks stalled: 4 jobs waiting and none finished in the last 25 min. Check that the worker is running.");
    expect(d.at(-1)!.text).toBe("21 locations waiting for a reviewer; the oldest has waited 9 h.");
  });
});
