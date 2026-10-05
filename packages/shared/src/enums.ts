// Shared vocabulary for server and web. Values are persisted, so never rename
// an existing value — add a new one and migrate.

export const ROLES = ["REVIEWER", "TEAM_LEAD", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

/** PRD §34 workflow states, plus SYNCING (see IMPLEMENTATION_PLAN C3). */
export const LOCATION_STATUSES = [
  "NEW",
  "QUEUED",
  "DOWNLOADING",
  "ANALYZING",
  "EVIDENCE_BUILDING",
  "AI_REVIEW_READY",
  "HUMAN_REVIEW",
  "APPROVED",
  "REJECTED",
  "ESCALATED",
  "SYNCING",
  "SYNCED_TO_NETSUITE",
  "COMPLETED",
  "IMAGE_ERROR",
  "AI_ERROR",
  "NETSUITE_ERROR",
  "INTEGRATION_ERROR",
] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

export const ERROR_STATUSES = [
  "IMAGE_ERROR",
  "AI_ERROR",
  "NETSUITE_ERROR",
  "INTEGRATION_ERROR",
] as const satisfies readonly LocationStatus[];
export type ErrorStatus = (typeof ERROR_STATUSES)[number];

/** PRD §26 — must never be collapsed into yes/no. */
export const SERVICE_ASSESSMENT_STATUSES = [
  "SUPPORTED",
  "NOT_SUPPORTED",
  "INSUFFICIENT_EVIDENCE",
  "CONTRADICTORY",
  "UNABLE_TO_DETERMINE",
] as const;
export type ServiceAssessmentStatus = (typeof SERVICE_ASSESSMENT_STATUSES)[number];

/** PRD §33 — bands shown to users instead of uncalibrated percentages. */
export const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** PRD §36 */
export const LANES = ["FAST", "HUMAN_REVIEW", "EXCEPTION"] as const;
export type Lane = (typeof LANES)[number];

/** AI output is a recommendation only — never a final decision. */
export const AI_RECOMMENDATIONS = [
  "RECOMMEND_APPROVE",
  "RECOMMEND_REJECT",
  "NEEDS_HUMAN_REVIEW",
] as const;
export type AiRecommendation = (typeof AI_RECOMMENDATIONS)[number];

/** Human decisions. Display labels are configurable; these codes are not. */
export const REVIEW_DECISIONS = ["APPROVE", "REJECT", "ESCALATE"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** PRD §30 structured override reasons. */
export const OVERRIDE_REASON_CODES = [
  "AI_MISSED_EVIDENCE",
  "AI_HALLUCINATED_EVIDENCE",
  "IMAGE_INSUFFICIENT",
  "BEFORE_AFTER_MISMATCH",
  "INCORRECT_SERVICE_INTERPRETATION",
  "CLIENT_SPECIFIC_RULE",
  "CONTRADICTORY_EVIDENCE",
  "OTHER",
] as const;
export type OverrideReasonCode = (typeof OVERRIDE_REASON_CODES)[number];

/** PRD §53. Levels 4 and 5 are deliberately not enable-able in this release. */
export const AUTOMATION_LEVELS = [0, 1, 2, 3, 4, 5] as const;
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];
export const MAX_ENABLED_AUTOMATION_LEVEL = 3;

/** PRD §78 retry categories. */
export const ERROR_CATEGORIES = [
  "TRANSIENT",
  "AUTHENTICATION",
  "INVALID_IMAGE",
  "MODEL_ERROR",
  "NETSUITE_VALIDATION",
  "CONFIGURATION",
  "INTERNAL",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const AUDIT_EVENT_TYPES = [
  "LOCATION_RECEIVED",
  "LOCATION_STATUS_CHANGED",
  "IMAGES_DOWNLOADED",
  "ANALYSIS_STARTED",
  "ANALYSIS_COMPLETED",
  "EVIDENCE_GENERATED",
  "RISK_CALCULATED",
  "REVIEW_OPENED",
  "EVIDENCE_VIEWED",
  "HUMAN_DECISION",
  "HUMAN_OVERRIDE",
  "NETSUITE_SYNC_ATTEMPTED",
  "NETSUITE_SYNC_SUCCEEDED",
  "NETSUITE_SYNC_FAILED",
  "REPROCESS_REQUESTED",
  "CONFIG_CHANGED",
  "USER_LOGIN",
  "USER_LOGIN_FAILED",
  "USER_LOGOUT",
  "USER_CREATED",
  "USER_UPDATED",
  "ERROR",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/** PRD §43 reprocessing reasons. */
export const REPROCESS_REASONS = [
  "NEW_IMAGES",
  "IMPROVED_MODEL",
  "CONFIG_CHANGE",
  "REVIEWER_DISPUTE",
  "TECHNICAL_ERROR",
] as const;
export type ReprocessReason = (typeof REPROCESS_REASONS)[number];
