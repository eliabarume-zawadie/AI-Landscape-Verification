import type { OverrideReasonCode } from "@alvip/shared";

/** Plain wording for reason codes in text that leaves ALVIP (NetSuite notes). */
export const REASON_TEXT: Record<OverrideReasonCode, string> = {
  AI_MISSED_EVIDENCE: "AI missed evidence",
  AI_HALLUCINATED_EVIDENCE: "AI reported evidence that is not in the photos",
  IMAGE_INSUFFICIENT: "photos are not good enough",
  BEFORE_AFTER_MISMATCH: "before and after photos do not match",
  INCORRECT_SERVICE_INTERPRETATION: "service was misread",
  CLIENT_SPECIFIC_RULE: "client-specific rule",
  CONTRADICTORY_EVIDENCE: "photos contradict each other",
  OTHER: "other",
};
