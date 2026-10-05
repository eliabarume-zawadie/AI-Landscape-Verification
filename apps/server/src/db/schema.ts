import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  AI_RECOMMENDATIONS,
  AUDIT_EVENT_TYPES,
  CONFIDENCE_LEVELS,
  ERROR_CATEGORIES,
  KNOWLEDGE_NOTE_KINDS,
  LANES,
  LOCATION_STATUSES,
  OVERRIDE_REASON_CODES,
  REVIEW_DECISIONS,
  RISK_LEVELS,
  ROLES,
  SERVICE_ASSESSMENT_STATUSES,
} from "@alvip/shared";

// ---------------------------------------------------------------- enums
export const roleEnum = pgEnum("role", ROLES);
export const locationStatusEnum = pgEnum("location_status", LOCATION_STATUSES);
export const serviceStatusEnum = pgEnum("service_assessment_status", SERVICE_ASSESSMENT_STATUSES);
export const confidenceEnum = pgEnum("confidence_level", CONFIDENCE_LEVELS);
export const riskEnum = pgEnum("risk_level", RISK_LEVELS);
export const laneEnum = pgEnum("lane", LANES);
export const aiRecommendationEnum = pgEnum("ai_recommendation", AI_RECOMMENDATIONS);
export const reviewDecisionEnum = pgEnum("review_decision", REVIEW_DECISIONS);
export const overrideReasonEnum = pgEnum("override_reason", OVERRIDE_REASON_CODES);
export const errorCategoryEnum = pgEnum("error_category", ERROR_CATEGORIES);
export const auditEventTypeEnum = pgEnum("audit_event_type", AUDIT_EVENT_TYPES);
export const runStatusEnum = pgEnum("run_status", ["RUNNING", "SUCCEEDED", "FAILED", "SUPERSEDED"]);
export const jobStatusEnum = pgEnum("job_status", ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "DEAD"]);
export const outboxStatusEnum = pgEnum("outbox_status", ["PENDING", "IN_FLIGHT", "SUCCEEDED", "FAILED", "DEAD"]);
export const evidenceRoleEnum = pgEnum("evidence_role", ["SUPPORTING", "CONTRADICTING", "CONTEXT"]);
export const actorTypeEnum = pgEnum("actor_type", ["USER", "SYSTEM", "WORKER"]);
export const knowledgeKindEnum = pgEnum("knowledge_kind", KNOWLEDGE_NOTE_KINDS);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------- identity
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    role: roleEnum("role").notNull(),
    passwordHash: text("password_hash").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    lastLoginAt: ts("last_login_at"),
  },
  (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** SHA-256 of the session token; the raw token only lives in the client cookie. */
    tokenHash: text("token_hash").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [uniqueIndex("sessions_token_hash_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------- configuration (versioned, immutable rows)
export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    displayName: text("display_name").notNull(),
    /** NetSuite reference once known (unknown U3). */
    externalRef: text("external_ref"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("clients_code_uq").on(t.code)],
);

export const clientProfiles = pgTable(
  "client_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id").notNull().references(() => clients.id),
    version: integer("version").notNull(),
    profile: jsonb("profile").notNull(),
    contentHash: text("content_hash").notNull(),
    isActive: boolean("is_active").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    changeNote: text("change_note"),
  },
  (t) => [
    uniqueIndex("client_profiles_version_uq").on(t.clientId, t.version),
    uniqueIndex("client_profiles_one_active_uq").on(t.clientId).where(sql`${t.isActive}`),
  ],
);

export const services = pgTable("services", {
  code: text("code").primaryKey(),
  displayName: text("display_name").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const serviceRuleVersions = pgTable(
  "service_rule_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: text("version").notNull(),
    rules: jsonb("rules").notNull(),
    contentHash: text("content_hash").notNull(),
    isActive: boolean("is_active").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    changeNote: text("change_note"),
  },
  (t) => [
    uniqueIndex("service_rule_versions_version_uq").on(t.version),
    uniqueIndex("service_rule_versions_one_active_uq").on(t.isActive).where(sql`${t.isActive}`),
  ],
);

export const thresholdVersions = pgTable(
  "threshold_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: text("version").notNull(),
    thresholds: jsonb("thresholds").notNull(),
    contentHash: text("content_hash").notNull(),
    provisional: boolean("provisional").notNull(),
    isActive: boolean("is_active").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    changeNote: text("change_note"),
  },
  (t) => [
    uniqueIndex("threshold_versions_version_uq").on(t.version),
    uniqueIndex("threshold_versions_one_active_uq").on(t.isActive).where(sql`${t.isActive}`),
  ],
);

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    template: text("template").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("prompt_versions_name_version_uq").on(t.name, t.version)],
);

export const modelVersions = pgTable(
  "model_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    modelVersion: text("model_version").notNull(),
    settings: jsonb("settings").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("model_versions_uq").on(t.provider, t.model, t.modelVersion)],
);

// ---------------------------------------------------------------- work items
export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** NetSuite identifier for the work item (location visit). Idempotent ingest key. */
    externalId: text("external_id").notNull(),
    externalLocationRef: text("external_location_ref"),
    clientId: uuid("client_id").notNull().references(() => clients.id),
    name: text("name"),
    serviceDate: ts("service_date"),
    status: locationStatusEnum("status").notNull().default("NEW"),
    lane: laneEnum("lane"),
    /** Current run's risk level and AI recommendation (for queue filters; history is per run). */
    riskLevel: riskEnum("risk_level"),
    aiRecommendation: aiRecommendationEnum("ai_recommendation"),
    priority: integer("priority").notNull().default(0),
    receivedAt: ts("received_at").notNull().defaultNow(),
    currentRunId: uuid("current_run_id"),
    /** Latest raw snapshot from the source system, for debugging. */
    sourceSnapshot: jsonb("source_snapshot"),
    statusChangedAt: ts("status_changed_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("locations_external_id_uq").on(t.externalId),
    index("locations_status_received_idx").on(t.status, t.receivedAt),
    index("locations_client_idx").on(t.clientId),
  ],
);

export const locationServices = pgTable(
  "location_services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id").notNull().references(() => locations.id),
    serviceCode: text("service_code").notNull().references(() => services.code),
    source: text("source").notNull(), // SOURCE_SYSTEM | CLIENT_PROFILE
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("location_services_uq").on(t.locationId, t.serviceCode)],
);

export const images = pgTable(
  "images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id").notNull().references(() => locations.id),
    externalRef: text("external_ref").notNull(),
    /** Opaque locator handed to the ImageProvider (from the source system). */
    locator: text("locator").notNull(),
    filename: text("filename"),
    ordinal: integer("ordinal"),
    capturedAt: ts("captured_at"),
    sha256: text("sha256"),
    /** 64-bit perceptual hash (dHash) as 16 hex chars. */
    perceptualHash: text("perceptual_hash"),
    /** 32×32 greyscale thumbnail, base64 — confirms near-duplicates (see domain/dedup.ts). */
    fingerprint: text("fingerprint"),
    /** 64-bin RGB histogram, base64 — shortlists before/after candidates. */
    colorHist: text("color_hist"),
    contentType: text("content_type"),
    format: text("format"),
    width: integer("width"),
    height: integer("height"),
    bytes: integer("bytes"),
    metadata: jsonb("metadata"),
    storageKey: text("storage_key"),
    downloadedAt: ts("downloaded_at"),
    downloadError: text("download_error"),
    /** Image bytes deleted under retention policy (PRD §51); metadata/analysis retained. */
    purgedAt: ts("purged_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("images_location_ref_uq").on(t.locationId, t.externalRef),
    index("images_sha256_idx").on(t.sha256),
  ],
);

// ---------------------------------------------------------------- processing
export const processingRuns = pgTable(
  "processing_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id").notNull().references(() => locations.id),
    runNumber: integer("run_number").notNull(),
    reason: text("reason").notNull(),
    status: runStatusEnum("status").notNull().default("RUNNING"),
    triggeredBy: uuid("triggered_by").references(() => users.id),
    automationLevel: integer("automation_level").notNull(),
    shadowMode: boolean("shadow_mode").notNull(),
    // PRD §42 versioning
    visionProvider: text("vision_provider"),
    visionModel: text("vision_model"),
    visionModelVersion: text("vision_model_version"),
    promptVersion: text("prompt_version"),
    serviceRuleVersionId: uuid("service_rule_version_id").references(() => serviceRuleVersions.id),
    clientProfileId: uuid("client_profile_id").references(() => clientProfiles.id),
    thresholdVersionId: uuid("threshold_version_id").references(() => thresholdVersions.id),
    applicationVersion: text("application_version").notNull(),
    // outputs
    aiRecommendation: aiRecommendationEnum("ai_recommendation"),
    lane: laneEnum("lane"),
    imageCount: integer("image_count"),
    uniqueImageCount: integer("unique_image_count"),
    aiCostUsd: numeric("ai_cost_usd", { precision: 12, scale: 6 }),
    startedAt: ts("started_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
    error: text("error"),
  },
  (t) => [
    uniqueIndex("processing_runs_location_run_uq").on(t.locationId, t.runNumber),
    index("processing_runs_location_idx").on(t.locationId),
  ],
);

export const imageAnalysis = pgTable(
  "image_analysis",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => processingRuns.id),
    imageId: uuid("image_id").notNull().references(() => images.id),
    qualityScore: real("quality_score"),
    usable: boolean("usable"),
    qualityIssues: jsonb("quality_issues").notNull().default([]),
    qualityMetrics: jsonb("quality_metrics"),
    /** Images in the same group are (near-)duplicates; the representative carries the evidence. */
    duplicateGroup: text("duplicate_group"),
    isDuplicateRepresentative: boolean("is_duplicate_representative"),
    duplicateKind: text("duplicate_kind"), // EXACT | NEAR | null
    relevant: boolean("relevant"),
    /** Validated vision observations (schema in AI_PIPELINE.md). */
    observations: jsonb("observations"),
    rawResponse: jsonb("raw_response"),
    validationError: text("validation_error"),
    /** Entries dropped by validation (e.g. hallucinated evidence types). */
    validationWarnings: jsonb("validation_warnings").notNull().default([]),
    /**
     * Vision outcome for this image: ANALYZED | CACHED | SKIPPED_UNUSABLE | SKIPPED_DUPLICATE
     * | MALFORMED | REFUSED | NOT_RUN. Only ANALYZED/CACHED observations can become evidence.
     */
    analysisStatus: text("analysis_status"),
    /** Model that actually answered (may differ from the configured one after a fallback). */
    servedModel: text("served_model"),
    /** Position in the "all images, strongest evidence first" order (1 = most useful). */
    evidenceRank: integer("evidence_rank"),
    /** Before/after stage from metadata only (BEFORE | AFTER | DURING | UNKNOWN). */
    stage: text("stage"),
    stageCertainty: text("stage_certainty"),
    stageSignals: jsonb("stage_signals"),
    cacheHit: boolean("cache_hit").notNull().default(false),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    latencyMs: integer("latency_ms"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("image_analysis_run_image_uq").on(t.runId, t.imageId)],
);

export const imagePairs = pgTable(
  "image_pairs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => processingRuns.id),
    beforeImageId: uuid("before_image_id").notNull().references(() => images.id),
    afterImageId: uuid("after_image_id").notNull().references(() => images.id),
    pairingScore: real("pairing_score").notNull(),
    pairingSignals: jsonb("pairing_signals").notNull(),
    changeAnalysis: jsonb("change_analysis"),
    /** CONFIRMED | NOT_SAME_AREA | NOT_COMPARABLE | LOW_CONFIDENCE | MALFORMED | REFUSED */
    status: text("status"),
    rawResponse: jsonb("raw_response"),
    validationError: text("validation_error"),
    servedModel: text("served_model"),
    cacheHit: boolean("cache_hit").notNull().default(false),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("image_pairs_uq").on(t.runId, t.beforeImageId, t.afterImageId)],
);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => processingRuns.id),
    serviceCode: text("service_code").notNull().references(() => services.code),
    imageId: uuid("image_id").references(() => images.id),
    imagePairId: uuid("image_pair_id").references(() => imagePairs.id),
    role: evidenceRoleEnum("role").notNull(),
    evidenceType: text("evidence_type").notNull(),
    strength: real("strength").notNull(),
    rank: integer("rank"),
    inBundle: boolean("in_bundle").notNull().default(false),
    observation: text("observation").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("evidence_run_service_idx").on(t.runId, t.serviceCode),
    check("evidence_source_ck", sql`${t.imageId} IS NOT NULL OR ${t.imagePairId} IS NOT NULL`),
  ],
);

export const serviceAssessments = pgTable(
  "service_assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => processingRuns.id),
    serviceCode: text("service_code").notNull().references(() => services.code),
    status: serviceStatusEnum("status").notNull(),
    confidenceLevel: confidenceEnum("confidence_level").notNull(),
    /** Internal, uncalibrated — never shown to users (PRD §33). */
    internalScore: real("internal_score"),
    humanRequired: boolean("human_required").notNull(),
    reasons: jsonb("reasons").notNull().default([]),
    explanation: text("explanation").notNull(),
    /** Decomposed services: status of each required component. */
    components: jsonb("components"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("service_assessments_run_service_uq").on(t.runId, t.serviceCode)],
);

export const riskAssessments = pgTable(
  "risk_assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => processingRuns.id),
    level: riskEnum("level").notNull(),
    internalScore: real("internal_score").notNull(),
    factors: jsonb("factors").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("risk_assessments_run_uq").on(t.runId)],
);

export const contradictions = pgTable(
  "contradictions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => processingRuns.id),
    serviceCode: text("service_code").notNull().references(() => services.code),
    supportingImageId: uuid("supporting_image_id").references(() => images.id),
    contradictingImageId: uuid("contradicting_image_id").references(() => images.id),
    description: text("description").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("contradictions_run_idx").on(t.runId)],
);

/**
 * Validated vision results keyed by image content + every input that can change the
 * answer (prompt hash, provider/model/settings, service rule version, requested
 * services). Avoids paying twice for the same image (PRD §49).
 */
export const visionCache = pgTable("vision_cache", {
  cacheKey: text("cache_key").primaryKey(),
  sha256: text("sha256").notNull(),
  result: jsonb("result").notNull(),
  servedModel: text("served_model").notNull(),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
  createdAt: createdAt(),
});

/** The reviewer's evidence bundle for a run (PRD §20–22). One row per bundled image. */
export const evidenceBundleItems = pgTable(
  "evidence_bundle_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => processingRuns.id),
    imageId: uuid("image_id").notNull().references(() => images.id),
    rank: integer("rank").notNull(),
    /** CONTRADICTION | COUNTER_EVIDENCE | BEFORE_AFTER_PAIR | TOP_SUPPORT | CONTEXT_ONLY */
    reasons: jsonb("reasons").notNull(),
    /** [{ service, role }] — one image can serve several services. */
    services: jsonb("services").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("evidence_bundle_items_run_image_uq").on(t.runId, t.imageId), index("evidence_bundle_items_run_rank_idx").on(t.runId, t.rank)],
);

// ---------------------------------------------------------------- queue
export const verificationJobs = pgTable(
  "verification_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    /** Prevents duplicate enqueues of the same logical work. */
    idempotencyKey: text("idempotency_key").notNull(),
    status: jobStatusEnum("status").notNull().default("PENDING"),
    priority: integer("priority").notNull().default(0),
    runAt: ts("run_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedBy: text("locked_by"),
    lockedUntil: ts("locked_until"),
    lastError: text("last_error"),
    lastErrorCategory: errorCategoryEnum("last_error_category"),
    locationId: uuid("location_id").references(() => locations.id),
    createdAt: createdAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    uniqueIndex("verification_jobs_idempotency_uq").on(t.idempotencyKey),
    index("verification_jobs_claim_idx").on(t.status, t.runAt, t.priority),
  ],
);

// ---------------------------------------------------------------- human review
export const humanReviews = pgTable(
  "human_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id").notNull().references(() => locations.id),
    runId: uuid("run_id").references(() => processingRuns.id),
    reviewerId: uuid("reviewer_id").notNull().references(() => users.id),
    decision: reviewDecisionEnum("decision").notNull(),
    /** { [serviceCode]: { decision, reason_code?, note? } } */
    serviceDecisions: jsonb("service_decisions").notNull().default({}),
    /** Snapshot of what the AI said at decision time (null at automation level 0 or shadow-hidden). */
    aiRecommendation: aiRecommendationEnum("ai_recommendation"),
    aiSnapshot: jsonb("ai_snapshot"),
    isOverride: boolean("is_override").notNull().default(false),
    reasonCode: overrideReasonEnum("reason_code"),
    reasonText: text("reason_text"),
    evidenceViewed: jsonb("evidence_viewed").notNull().default([]),
    shadowMode: boolean("shadow_mode").notNull().default(false),
    openedAt: ts("opened_at"),
    submittedAt: ts("submitted_at").notNull().defaultNow(),
  },
  (t) => [index("human_reviews_location_idx").on(t.locationId)],
);

/**
 * PRD §30: one immutable row per service the reviewer disagreed on (serviceCode null = the
 * location-level recommendation), × each photo the reviewer flagged (imageId null = none).
 * Evaluation/training input only — nothing reads it to change production behaviour.
 */
export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id").notNull().references(() => humanReviews.id),
    locationId: uuid("location_id").notNull().references(() => locations.id),
    runId: uuid("run_id").references(() => processingRuns.id),
    reviewerId: uuid("reviewer_id").notNull().references(() => users.id),
    serviceCode: text("service_code").references(() => services.code),
    imageId: uuid("image_id").references(() => images.id),
    aiRecommendation: aiRecommendationEnum("ai_recommendation"),
    aiStatus: serviceStatusEnum("ai_status"),
    aiConfidence: confidenceEnum("ai_confidence"),
    humanDecision: reviewDecisionEnum("human_decision").notNull(),
    /** True when the human went against the AI; false = feedback given while agreeing. */
    isOverride: boolean("is_override").notNull(),
    reasonCode: overrideReasonEnum("reason_code").notNull(),
    reasonText: text("reason_text"),
    createdAt: createdAt(),
  },
  (t) => [
    index("feedback_review_idx").on(t.reviewId),
    index("feedback_created_idx").on(t.createdAt),
    index("feedback_reason_idx").on(t.reasonCode, t.createdAt),
  ],
);

// ---------------------------------------------------------------- NetSuite outbox
export const netsuiteSyncOutbox = pgTable(
  "netsuite_sync_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id").notNull().references(() => locations.id),
    reviewId: uuid("review_id").references(() => humanReviews.id),
    operation: text("operation").notNull(), // UPDATE_VERIFICATION | ADD_NOTE
    payload: jsonb("payload").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: outboxStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    lastErrorCategory: errorCategoryEnum("last_error_category"),
    createdAt: createdAt(),
    syncedAt: ts("synced_at"),
  },
  (t) => [
    uniqueIndex("netsuite_sync_outbox_idempotency_uq").on(t.idempotencyKey),
    index("netsuite_sync_outbox_due_idx").on(t.status, t.nextAttemptAt),
  ],
);

// ---------------------------------------------------------------- audit + errors
/** Append-only. UPDATE/DELETE are blocked by a trigger (see migration 0001). */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    eventType: auditEventTypeEnum("event_type").notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    locationId: uuid("location_id"),
    runId: uuid("run_id"),
    data: jsonb("data").notNull().default({}),
    ip: text("ip"),
  },
  (t) => [
    index("audit_events_location_idx").on(t.locationId, t.occurredAt),
    index("audit_events_type_idx").on(t.eventType, t.occurredAt),
  ],
);

export const systemErrors = pgTable(
  "system_errors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    category: errorCategoryEnum("category").notNull(),
    source: text("source").notNull(),
    message: text("message").notNull(),
    details: jsonb("details"),
    locationId: uuid("location_id").references(() => locations.id),
    runId: uuid("run_id").references(() => processingRuns.id),
    jobId: uuid("job_id").references(() => verificationJobs.id),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    resolvedAt: ts("resolved_at"),
    resolvedBy: uuid("resolved_by").references(() => users.id),
  },
  (t) => [index("system_errors_open_idx").on(t.resolvedAt, t.occurredAt)],
);

// ---------------------------------------------------------------- knowledge base (Phase 10)
/**
 * PRD §31 reviewer guidance. Content is immutable (DB trigger): revising creates a new note
 * that supersedes the old one, which is archived. Scope: clientId/serviceCode null = all.
 */
export const knowledgeNotes = pgTable(
  "knowledge_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id").references(() => clients.id),
    serviceCode: text("service_code").references(() => services.code),
    kind: knowledgeKindEnum("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Where the note came from, e.g. "Weekly feedback 2026-09-28" or an import file. */
    source: text("source"),
    authorId: uuid("author_id").references(() => users.id),
    supersedesId: uuid("supersedes_id"),
    createdAt: createdAt(),
    archivedAt: ts("archived_at"),
    archivedBy: uuid("archived_by").references(() => users.id),
    archiveReason: text("archive_reason"),
  },
  (t) => [index("knowledge_notes_scope_idx").on(t.clientId, t.serviceCode), index("knowledge_notes_active_idx").on(t.archivedAt, t.createdAt)],
);
