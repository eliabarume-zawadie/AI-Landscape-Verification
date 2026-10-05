/** Reviewer-facing words for system codes. Plain language, sentence case. */

export const STATUS_LABEL: Record<string, string> = {
  SUPPORTED: "Supported",
  NOT_SUPPORTED: "Not supported",
  INSUFFICIENT_EVIDENCE: "Not enough evidence",
  CONTRADICTORY: "Contradictory",
  UNABLE_TO_DETERMINE: "Couldn't assess",
};

export type Tone = "supported" | "caution" | "against" | "neutral";
export const STATUS_TONE: Record<string, Tone> = {
  SUPPORTED: "supported",
  NOT_SUPPORTED: "against",
  INSUFFICIENT_EVIDENCE: "caution",
  CONTRADICTORY: "against",
  UNABLE_TO_DETERMINE: "caution",
};

export const RECOMMENDATION_LABEL: Record<string, string> = {
  RECOMMEND_APPROVE: "AI suggests approving",
  RECOMMEND_REJECT: "AI suggests rejecting",
  NEEDS_HUMAN_REVIEW: "AI can't decide — your call",
};

export const RISK_TONE: Record<string, Tone> = { LOW: "supported", MEDIUM: "caution", HIGH: "against" };

export const LOCATION_STATUS_LABEL: Record<string, string> = {
  NEW: "New",
  QUEUED: "Queued",
  DOWNLOADING: "Fetching photos",
  ANALYZING: "AI analysing",
  EVIDENCE_BUILDING: "Building evidence",
  AI_REVIEW_READY: "Ready for review",
  HUMAN_REVIEW: "Awaiting review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  ESCALATED: "Escalated",
  SYNCING: "Sending to NetSuite",
  SYNCED_TO_NETSUITE: "Sent to NetSuite",
  COMPLETED: "Completed",
  IMAGE_ERROR: "Photo problem",
  AI_ERROR: "AI problem",
  NETSUITE_ERROR: "NetSuite problem",
  INTEGRATION_ERROR: "Data problem",
};

export const ROLE_LABEL: Record<string, string> = {
  SUPPORTING: "supports",
  CONTRADICTING: "against",
  CONTEXT: "context",
  BEFORE: "before",
  AFTER: "after",
};

export const REASON_LABEL: Record<string, string> = {
  AI_MISSED_EVIDENCE: "AI missed evidence",
  AI_HALLUCINATED_EVIDENCE: "AI saw something that isn't there",
  IMAGE_INSUFFICIENT: "Photos aren't good enough",
  BEFORE_AFTER_MISMATCH: "Before/after don't match",
  INCORRECT_SERVICE_INTERPRETATION: "Service misread",
  CLIENT_SPECIFIC_RULE: "Client-specific rule",
  CONTRADICTORY_EVIDENCE: "Evidence contradicts itself",
  OTHER: "Other (describe)",
};

/** Engine reason codes → short reviewer phrases. Unknown codes fall back to readable text. */
const ENGINE_REASON: Record<string, string> = {
  SINGLE_INDEPENDENT_IMAGE: "only one independent photo",
  BEFORE_AFTER_NOT_ESTABLISHED: "no matching before/after",
  BEFORE_AFTER_NOT_YET_EVALUATED: "before/after not checked",
  MIN_USABLE_IMAGES_NOT_MET: "too few usable photos",
  MIN_DISTINCT_SCENES_NOT_MET: "too few areas covered",
  SCENE_COVERAGE_NOT_YET_EVALUATED: "area coverage not checked",
  ONLY_CONTEXT_EVIDENCE: "only context (equipment, appearance)",
  NO_RELEVANT_EVIDENCE: "nothing relevant visible",
  BELOW_CONFIDENCE_THRESHOLD: "evidence too weak",
  CONTRADICTING_EVIDENCE: "photos disagree",
  NEGATIVE_EVIDENCE_ONLY: "photos show work not done",
  WEAK_COUNTER_EVIDENCE: "some counter-evidence",
  SOME_IMAGES_NOT_ANALYSED: "some photos not analysed",
  RULE_REQUIRES_HUMAN_REVIEW: "rule requires a person",
  NO_USABLE_ANALYSED_IMAGES: "no usable photos",
  AI_ANALYSIS_FAILED: "AI couldn't read the photos",
};
export const engineReason = (code: string) => ENGINE_REASON[code] ?? code.toLowerCase().replaceAll("_", " ");

export const humanize = (code: string) => code.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export function age(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

/** "mowing · after, supports  ·  edging · supports" — one entry per service. */
export function rolesCaption(services: { service: string; role: string }[]): string {
  const by = new Map<string, string[]>();
  for (const s of services) by.set(s.service, [...(by.get(s.service) ?? []), ROLE_LABEL[s.role] ?? s.role.toLowerCase()]);
  return [...by.entries()].map(([svc, roles]) => `${svc.replaceAll("_", " ")} · ${roles.join(", ")}`).join("  ·  ");
}
