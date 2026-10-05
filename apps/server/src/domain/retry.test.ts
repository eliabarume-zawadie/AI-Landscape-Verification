import { describe, expect, it } from "vitest";
import { backoffDelayMs, decideFailureOutcome, isRetryable } from "./retry";

describe("retry policy (PRD §78)", () => {
  it("retries only transient and model errors", () => {
    expect(isRetryable("TRANSIENT")).toBe(true);
    expect(isRetryable("MODEL_ERROR")).toBe(true);
    for (const c of ["AUTHENTICATION", "INVALID_IMAGE", "NETSUITE_VALIDATION", "CONFIGURATION", "INTERNAL"] as const) {
      expect(isRetryable(c), c).toBe(false);
    }
  });

  it("stops retrying after max attempts", () => {
    expect(decideFailureOutcome("TRANSIENT", 4, 5)).toBe("RETRY");
    expect(decideFailureOutcome("TRANSIENT", 5, 5)).toBe("DEAD");
    expect(decideFailureOutcome("AUTHENTICATION", 1, 5)).toBe("DEAD");
  });

  it("backs off exponentially up to a cap", () => {
    const p = { baseMs: 1000, capMs: 10_000 };
    // jitter 0 → half of the exponential value
    expect([1, 2, 3, 4, 10].map((n) => backoffDelayMs(n, p, 0))).toEqual([500, 1000, 2000, 4000, 5000]);
  });

  it("keeps jittered delays within [half, full]", () => {
    const p = { baseMs: 1000, capMs: 10_000 };
    expect(backoffDelayMs(3, p, 0)).toBe(2000);
    expect(backoffDelayMs(3, p, 0.5)).toBe(3000);
  });
});
