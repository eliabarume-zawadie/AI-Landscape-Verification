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

/** PRD §31 knowledge-base note kinds. Notes are guidance; they never change client rules. */
export const KNOWLEDGE_NOTE_KINDS = [
  "REVIEWER_NOTE",
  "SERVICE_DEFINITION",
  "CLIENT_INSTRUCTION",
  "EDGE_CASE",
  "WEEKLY_FEEDBACK",
  "HISTORICAL_EXAMPLE",
] as const;
export type KnowledgeNoteKind = (typeof KNOWLEDGE_NOTE_KINDS)[number];

/** PRD §55 / §85 case types a golden dataset must cover. */
export const GOLDEN_CASE_TAGS = [
  "CLEAR_APPROVAL",
  "CLEAR_REJECTION",
  "AMBIGUOUS",
  "POOR_QUALITY",
  "DUPLICATES",
  "CONTRADICTION",
  "BEFORE_AFTER",
  "MISSING_BEFORE",
  "MISSING_AFTER",
  "MULTIPLE_SERVICES",
  "DIFFICULT_CONDITIONS",
] as const;
export type GoldenCaseTag = (typeof GOLDEN_CASE_TAGS)[number];
export const GOLDEN_STATUSES = ["DRAFT", "APPROVED", "RETIRED"] as const;
export type GoldenStatus = (typeof GOLDEN_STATUSES)[number];
/** The business truth for one service in a golden example. */
export const GOLDEN_EXPECTED = ["APPROVE", "REJECT"] as const;
export type GoldenExpected = (typeof GOLDEN_EXPECTED)[number];

/**
 * PRD §90 rollout stages, set per client (Phase 15). Ordered: each includes the one before.
 *   MANUAL     — no AI analysis; reviewers verify the photos themselves.
 *   SHADOW     — stage 2: AI analyses live locations, result hidden from people deciding.
 *   ASSIST     — stages 3–4: reviewers see AI evidence, bundle and suggestion.
 *   FAST_TRACK — stage 5: low-risk "approve" suggestions for listed services go to the Fast
 *                Lane, where a person still confirms. Stage 6 (automation) is not available.
 */
export const ROLLOUT_MODES = ["MANUAL", "SHADOW", "ASSIST", "FAST_TRACK"] as const;
export type RolloutMode = (typeof ROLLOUT_MODES)[number];

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
  "IMAGE_QUALITY_ASSESSED",
  "IMAGES_PURGED",
  "ANALYSIS_STARTED",
  "ANALYSIS_COMPLETED",
  "AI_VISION_COMPLETED",
  "BEFORE_AFTER_COMPLETED",
  "EVIDENCE_GENERATED",
  "EVIDENCE_BUNDLED",
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
  "KNOWLEDGE_NOTE_CREATED",
  "KNOWLEDGE_NOTE_ARCHIVED",
  "FEEDBACK_EXPORTED",
  "NETSUITE_SYNC_RETRY_REQUESTED",
  "GOLDEN_EXAMPLE_CREATED",
  "GOLDEN_EXAMPLE_UPDATED",
  "GOLDEN_EXAMPLE_APPROVED",
  "GOLDEN_EXAMPLE_RETIRED",
  "EVALUATION_REQUESTED",
  "EVALUATION_COMPLETED",
  "ROLLOUT_CHANGED",
  "QC_SAMPLED",
  "QC_COMPLETED",
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

/** PRD §24 risk factors. Weights and floors live in thresholds (provisional). */
export const RISK_FACTORS = [
  "CONTRADICTION",
  "UNABLE_TO_DETERMINE",
  "NOT_SUPPORTED",
  "INSUFFICIENT_EVIDENCE",
  "CLIENT_STRICT_RULE",
  "ANALYSIS_FAILURES",
  "MISSING_BEFORE_AFTER",
  "WEAK_COUNTER_EVIDENCE",
  "CONFLICTING_SERVICE_OUTCOMES",
  "LOW_CONFIDENCE",
  "POOR_IMAGE_QUALITY",
  "UNUSUAL_SCENE",
  "DUPLICATE_HEAVY",
] as const;
export type RiskFactor = (typeof RISK_FACTORS)[number];
