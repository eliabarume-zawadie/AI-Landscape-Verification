CREATE TYPE "public"."actor_type" AS ENUM('USER', 'SYSTEM', 'WORKER');--> statement-breakpoint
CREATE TYPE "public"."ai_recommendation" AS ENUM('RECOMMEND_APPROVE', 'RECOMMEND_REJECT', 'NEEDS_HUMAN_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."audit_event_type" AS ENUM('LOCATION_RECEIVED', 'LOCATION_STATUS_CHANGED', 'IMAGES_DOWNLOADED', 'ANALYSIS_STARTED', 'ANALYSIS_COMPLETED', 'EVIDENCE_GENERATED', 'RISK_CALCULATED', 'REVIEW_OPENED', 'EVIDENCE_VIEWED', 'HUMAN_DECISION', 'HUMAN_OVERRIDE', 'NETSUITE_SYNC_ATTEMPTED', 'NETSUITE_SYNC_SUCCEEDED', 'NETSUITE_SYNC_FAILED', 'REPROCESS_REQUESTED', 'CONFIG_CHANGED', 'USER_LOGIN', 'USER_LOGIN_FAILED', 'USER_LOGOUT', 'USER_CREATED', 'USER_UPDATED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."confidence_level" AS ENUM('HIGH', 'MEDIUM', 'LOW');--> statement-breakpoint
CREATE TYPE "public"."error_category" AS ENUM('TRANSIENT', 'AUTHENTICATION', 'INVALID_IMAGE', 'MODEL_ERROR', 'NETSUITE_VALIDATION', 'CONFIGURATION', 'INTERNAL');--> statement-breakpoint
CREATE TYPE "public"."evidence_role" AS ENUM('SUPPORTING', 'CONTRADICTING', 'CONTEXT');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."lane" AS ENUM('FAST', 'HUMAN_REVIEW', 'EXCEPTION');--> statement-breakpoint
CREATE TYPE "public"."location_status" AS ENUM('NEW', 'QUEUED', 'DOWNLOADING', 'ANALYZING', 'EVIDENCE_BUILDING', 'AI_REVIEW_READY', 'HUMAN_REVIEW', 'APPROVED', 'REJECTED', 'ESCALATED', 'SYNCING', 'SYNCED_TO_NETSUITE', 'COMPLETED', 'IMAGE_ERROR', 'AI_ERROR', 'NETSUITE_ERROR', 'INTEGRATION_ERROR');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."override_reason" AS ENUM('AI_MISSED_EVIDENCE', 'AI_HALLUCINATED_EVIDENCE', 'IMAGE_INSUFFICIENT', 'BEFORE_AFTER_MISMATCH', 'INCORRECT_SERVICE_INTERPRETATION', 'CLIENT_SPECIFIC_RULE', 'CONTRADICTORY_EVIDENCE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."review_decision" AS ENUM('APPROVE', 'REJECT', 'ESCALATE');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('REVIEWER', 'TEAM_LEAD', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('RUNNING', 'SUCCEEDED', 'FAILED', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."service_assessment_status" AS ENUM('SUPPORTED', 'NOT_SUPPORTED', 'INSUFFICIENT_EVIDENCE', 'CONTRADICTORY', 'UNABLE_TO_DETERMINE');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" "audit_event_type" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"entity_type" text,
	"entity_id" text,
	"location_id" uuid,
	"run_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "client_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"profile" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"change_note" text
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"display_name" text NOT NULL,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contradictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"service_code" text NOT NULL,
	"supporting_image_id" uuid,
	"contradicting_image_id" uuid,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"service_code" text NOT NULL,
	"image_id" uuid,
	"image_pair_id" uuid,
	"role" "evidence_role" NOT NULL,
	"evidence_type" text NOT NULL,
	"strength" real NOT NULL,
	"rank" integer,
	"in_bundle" boolean DEFAULT false NOT NULL,
	"observation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_source_ck" CHECK ("evidence"."image_id" IS NOT NULL OR "evidence"."image_pair_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"service_code" text,
	"image_id" uuid,
	"ai_status" "service_assessment_status",
	"human_decision" "review_decision" NOT NULL,
	"reason_code" "override_reason" NOT NULL,
	"reason_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "human_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"run_id" uuid,
	"reviewer_id" uuid NOT NULL,
	"decision" "review_decision" NOT NULL,
	"service_decisions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_recommendation" "ai_recommendation",
	"ai_snapshot" jsonb,
	"is_override" boolean DEFAULT false NOT NULL,
	"reason_code" "override_reason",
	"reason_text" text,
	"evidence_viewed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"shadow_mode" boolean DEFAULT false NOT NULL,
	"opened_at" timestamp with time zone,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_analysis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"image_id" uuid NOT NULL,
	"quality_score" real,
	"usable" boolean,
	"quality_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quality_metrics" jsonb,
	"duplicate_group" text,
	"is_duplicate_representative" boolean,
	"relevant" boolean,
	"observations" jsonb,
	"raw_response" jsonb,
	"validation_error" text,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_pairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"before_image_id" uuid NOT NULL,
	"after_image_id" uuid NOT NULL,
	"pairing_score" real NOT NULL,
	"pairing_signals" jsonb NOT NULL,
	"change_analysis" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"filename" text,
	"ordinal" integer,
	"captured_at" timestamp with time zone,
	"sha256" text,
	"perceptual_hash" text,
	"format" text,
	"width" integer,
	"height" integer,
	"bytes" integer,
	"metadata" jsonb,
	"storage_key" text,
	"downloaded_at" timestamp with time zone,
	"download_error" text,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"service_code" text,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"source" text,
	"author_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "location_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"service_code" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"external_location_ref" text,
	"client_id" uuid NOT NULL,
	"name" text,
	"service_date" timestamp with time zone,
	"status" "location_status" DEFAULT 'NEW' NOT NULL,
	"lane" "lane",
	"priority" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"current_run_id" uuid,
	"source_snapshot" jsonb,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"model_version" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "netsuite_sync_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"review_id" uuid,
	"operation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"last_error_category" "error_category",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "processing_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"run_number" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "run_status" DEFAULT 'RUNNING' NOT NULL,
	"triggered_by" uuid,
	"automation_level" integer NOT NULL,
	"shadow_mode" boolean NOT NULL,
	"vision_provider" text,
	"vision_model" text,
	"vision_model_version" text,
	"prompt_version" text,
	"service_rule_version_id" uuid,
	"client_profile_id" uuid,
	"threshold_version_id" uuid,
	"application_version" text NOT NULL,
	"ai_recommendation" "ai_recommendation",
	"lane" "lane",
	"image_count" integer,
	"unique_image_count" integer,
	"ai_cost_usd" numeric(12, 6),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"template" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"level" "risk_level" NOT NULL,
	"internal_score" real NOT NULL,
	"factors" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"service_code" text NOT NULL,
	"status" "service_assessment_status" NOT NULL,
	"confidence_level" "confidence_level" NOT NULL,
	"internal_score" real,
	"human_required" boolean NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"explanation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_rule_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"rules" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"change_note" text
);
--> statement-breakpoint
CREATE TABLE "services" (
	"code" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "system_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" "error_category" NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL,
	"details" jsonb,
	"location_id" uuid,
	"run_id" uuid,
	"job_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid
);
--> statement-breakpoint
CREATE TABLE "threshold_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"thresholds" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"provisional" boolean NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"change_note" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "role" NOT NULL,
	"password_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "verification_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "job_status" DEFAULT 'PENDING' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"last_error_category" "error_category",
	"location_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "client_profiles" ADD CONSTRAINT "client_profiles_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_profiles" ADD CONSTRAINT "client_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contradictions" ADD CONSTRAINT "contradictions_run_id_processing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."processing_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contradictions" ADD CONSTRAINT "contradictions_service_code_services_code_fk" FOREIGN KEY ("service_code") REFERENCES "public"."services"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contradictions" ADD CONSTRAINT "contradictions_supporting_image_id_images_id_fk" FOREIGN KEY ("supporting_image_id") REFERENCES "public"."images"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contradictions" ADD CONSTRAINT "contradictions_contradicting_image_id_images_id_fk" FOREIGN KEY ("contradicting_image_id") REFERENCES "public"."images"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_run_id_processing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."processing_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_service_code_services_code_fk" FOREIGN KEY ("service_code") REFERENCES "public"."services"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_image_pair_id_image_pairs_id_fk" FOREIGN KEY ("image_pair_id") REFERENCES "public"."image_pairs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_review_id_human_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."human_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_service_code_services_code_fk" FOREIGN KEY ("service_code") REFERENCES "public"."services"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_reviews" ADD CONSTRAINT "human_reviews_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_reviews" ADD CONSTRAINT "human_reviews_run_id_processing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."processing_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_reviews" ADD CONSTRAINT "human_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_analysis" ADD CONSTRAINT "image_analysis_run_id_processing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."processing_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_analysis" ADD CONSTRAINT "image_analysis_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_pairs" ADD CONSTRAINT "image_pairs_run_id_processing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."processing_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_pairs" ADD CONSTRAINT "image_pairs_before_image_id_images_id_fk" FOREIGN KEY ("before_image_id") REFERENCES "public"."images"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_pairs" ADD CONSTRAINT "image_pairs_after_image_id_images_id_fk" FOREIGN KEY ("after_image_id") REFERENCES "public"."images"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_notes" ADD CONSTRAINT "knowledge_notes_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_notes" ADD CONSTRAINT "knowledge_notes_service_code_services_code_fk" FOREIGN KEY ("service_code") REFERENCES "public"."services"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_notes" ADD CONSTRAINT "knowledge_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_services" ADD CONSTRAINT "location_services_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_services" ADD CONSTRAINT "location_services_service_code_services_code_fk" FOREIGN KEY ("service_code") REFERENCES "public"."services"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "netsuite_sync_outbox" ADD CONSTRAINT "netsuite_sync_outbox_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "netsuite_sync_outbox" ADD CONSTRAINT "netsuite_sync_outbox_review_id_human_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."human_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_service_rule_version_id_service_rule_versions_id_fk" FOREIGN KEY ("service_rule_version_id") REFERENCES "public"."service_rule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_client_profile_id_client_profiles_id_fk" FOREIGN KEY ("client_profile_id") REFERENCES "public"."client_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_threshold_version_id_threshold_versions_id_fk" FOREIGN KEY ("threshold_version_id") REFERENCES "public"."threshold_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_run_id_processing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."processing_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_assessments" ADD CONSTRAINT "service_assessments_run_id_processing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."processing_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_assessments" ADD CONSTRAINT "service_assessments_service_code_services_code_fk" FOREIGN KEY ("service_code") REFERENCES "public"."services"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_rule_versions" ADD CONSTRAINT "service_rule_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_errors" ADD CONSTRAINT "system_errors_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_errors" ADD CONSTRAINT "system_errors_run_id_processing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."processing_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_errors" ADD CONSTRAINT "system_errors_job_id_verification_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."verification_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_errors" ADD CONSTRAINT "system_errors_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threshold_versions" ADD CONSTRAINT "threshold_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_jobs" ADD CONSTRAINT "verification_jobs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_location_idx" ON "audit_events" USING btree ("location_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_type_idx" ON "audit_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "client_profiles_version_uq" ON "client_profiles" USING btree ("client_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "client_profiles_one_active_uq" ON "client_profiles" USING btree ("client_id") WHERE "client_profiles"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "clients_code_uq" ON "clients" USING btree ("code");--> statement-breakpoint
CREATE INDEX "contradictions_run_idx" ON "contradictions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "evidence_run_service_idx" ON "evidence" USING btree ("run_id","service_code");--> statement-breakpoint
CREATE INDEX "feedback_review_idx" ON "feedback" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "human_reviews_location_idx" ON "human_reviews" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "image_analysis_run_image_uq" ON "image_analysis" USING btree ("run_id","image_id");--> statement-breakpoint
CREATE UNIQUE INDEX "image_pairs_uq" ON "image_pairs" USING btree ("run_id","before_image_id","after_image_id");--> statement-breakpoint
CREATE UNIQUE INDEX "images_location_ref_uq" ON "images" USING btree ("location_id","external_ref");--> statement-breakpoint
CREATE INDEX "images_sha256_idx" ON "images" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "knowledge_notes_scope_idx" ON "knowledge_notes" USING btree ("client_id","service_code");--> statement-breakpoint
CREATE UNIQUE INDEX "location_services_uq" ON "location_services" USING btree ("location_id","service_code");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_external_id_uq" ON "locations" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "locations_status_received_idx" ON "locations" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "locations_client_idx" ON "locations" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_versions_uq" ON "model_versions" USING btree ("provider","model","model_version");--> statement-breakpoint
CREATE UNIQUE INDEX "netsuite_sync_outbox_idempotency_uq" ON "netsuite_sync_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "netsuite_sync_outbox_due_idx" ON "netsuite_sync_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_runs_location_run_uq" ON "processing_runs" USING btree ("location_id","run_number");--> statement-breakpoint
CREATE INDEX "processing_runs_location_idx" ON "processing_runs" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_name_version_uq" ON "prompt_versions" USING btree ("name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_assessments_run_uq" ON "risk_assessments" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_assessments_run_service_uq" ON "service_assessments" USING btree ("run_id","service_code");--> statement-breakpoint
CREATE UNIQUE INDEX "service_rule_versions_version_uq" ON "service_rule_versions" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "service_rule_versions_one_active_uq" ON "service_rule_versions" USING btree ("is_active") WHERE "service_rule_versions"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "system_errors_open_idx" ON "system_errors" USING btree ("resolved_at","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "threshold_versions_version_uq" ON "threshold_versions" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "threshold_versions_one_active_uq" ON "threshold_versions" USING btree ("is_active") WHERE "threshold_versions"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "verification_jobs_idempotency_uq" ON "verification_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "verification_jobs_claim_idx" ON "verification_jobs" USING btree ("status","run_at","priority");