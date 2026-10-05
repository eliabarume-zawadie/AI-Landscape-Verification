import { describe, expect, it } from "vitest";
import { LOCATION_STATUSES, type LocationStatus } from "@alvip/shared";
import {
  allowedTransitions,
  assertTransition,
  canReprocess,
  canTransition,
  InvalidTransitionError,
  isErrorStatus,
  laneForErrorStatus,
} from "./locationState";

describe("location state machine", () => {
  it("follows the PRD happy path", () => {
    const path: LocationStatus[] = [
      "NEW",
      "QUEUED",
      "DOWNLOADING",
      "ANALYZING",
      "EVIDENCE_BUILDING",
      "AI_REVIEW_READY",
      "HUMAN_REVIEW",
      "APPROVED",
      "SYNCING",
      "SYNCED_TO_NETSUITE",
      "COMPLETED",
    ];
    for (let i = 1; i < path.length; i++) {
      expect(canTransition(path[i - 1]!, path[i]!), `${path[i - 1]} → ${path[i]}`).toBe(true);
    }
  });

  it("defines transitions for every status", () => {
    for (const s of LOCATION_STATUSES) expect(Array.isArray(allowedTransitions(s))).toBe(true);
  });

  it("only reaches APPROVED or REJECTED from a human-review state", () => {
    // Safety invariant: there is no edge into a decision from any AI/processing state.
    for (const from of LOCATION_STATUSES) {
      for (const decision of ["APPROVED", "REJECTED"] as const) {
        if (canTransition(from, decision)) {
          expect(["HUMAN_REVIEW", "ESCALATED"]).toContain(from);
        }
      }
    }
  });

  it("rejects skipping straight from AI_REVIEW_READY to APPROVED", () => {
    expect(() => assertTransition("AI_REVIEW_READY", "APPROVED")).toThrow(InvalidTransitionError);
  });

  it("keeps a decision waiting to sync from being reprocessed", () => {
    for (const s of ["APPROVED", "REJECTED", "SYNCING", "NETSUITE_ERROR"] as const) {
      expect(canReprocess(s), s).toBe(false);
    }
  });

  it("allows reprocessing from review, completed, and error states", () => {
    for (const s of ["AI_REVIEW_READY", "HUMAN_REVIEW", "ESCALATED", "COMPLETED", "AI_ERROR", "IMAGE_ERROR"] as const) {
      expect(canReprocess(s), s).toBe(true);
    }
  });

  it("does not count crash-recovery requeue of in-progress work as reprocessing", () => {
    expect(canTransition("ANALYZING", "QUEUED")).toBe(true);
    expect(canReprocess("ANALYZING")).toBe(false);
  });

  it("lets a failed NetSuite sync be retried without losing the decision", () => {
    expect(canTransition("NETSUITE_ERROR", "SYNCING")).toBe(true);
    expect(canTransition("NETSUITE_ERROR", "HUMAN_REVIEW")).toBe(false);
  });

  it("allows manual fallback to human review when AI fails", () => {
    expect(canTransition("AI_ERROR", "HUMAN_REVIEW")).toBe(true);
  });

  it("routes error states to the exception lane", () => {
    expect(isErrorStatus("AI_ERROR")).toBe(true);
    expect(isErrorStatus("HUMAN_REVIEW")).toBe(false);
    expect(laneForErrorStatus("NETSUITE_ERROR")).toBe("EXCEPTION");
    expect(laneForErrorStatus("QUEUED")).toBeNull();
  });
});
