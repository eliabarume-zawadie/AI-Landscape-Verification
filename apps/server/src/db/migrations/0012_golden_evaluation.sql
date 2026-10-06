CREATE TYPE "public"."evaluation_status" AS ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."golden_status" AS ENUM('DRAFT', 'APPROVED', 'RETIRED');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'GOLDEN_EXAMPLE_CREATED';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'GOLDEN_EXAMPLE_UPDATED';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'GOLDEN_EXAMPLE_APPROVED';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'GOLDEN_EXAMPLE_RETIRED';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'EVALUATION_REQUESTED';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'EVALUATION_COMPLETED';--> statement-breakpoint
CREATE TABLE "evaluation_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"example_id" uuid NOT NULL,
	"service_code" text,
	"expected" text NOT NULL,
	"ai_status" text,
	"ai_confidence" text,
	"predicted" text NOT NULL,
	"outcome" text NOT NULL,
	"explanation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text,
	"status" "evaluation_status" DEFAULT 'PENDING' NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"versions" jsonb,
	"example_count" integer,
	"summary" jsonb,
	"cost_usd" numeric(12, 6),
	"error" text
);
--> statement-breakpoint
CREATE TABLE "golden_example_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"example_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"external_ref" text NOT NULL,
	"filename" text,
	"captured_at" timestamp with time zone,
	"sha256" text NOT NULL,
	"content_type" text,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "golden_examples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"client_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_location_id" uuid,
	"source_review_id" uuid,
	"services" jsonb NOT NULL,
	"expected" jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewer_decision" text,
	"reason" text,
	"notes" text,
	"status" "golden_status" DEFAULT 'DRAFT' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"retired_by" uuid,
	"retired_at" timestamp with time zone,
	"retire_reason" text,
	"supersedes_id" uuid
);
--> statement-breakpoint
ALTER TABLE "evaluation_results" ADD CONSTRAINT "evaluation_results_run_id_evaluation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_results" ADD CONSTRAINT "evaluation_results_example_id_golden_examples_id_fk" FOREIGN KEY ("example_id") REFERENCES "public"."golden_examples"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golden_example_images" ADD CONSTRAINT "golden_example_images_example_id_golden_examples_id_fk" FOREIGN KEY ("example_id") REFERENCES "public"."golden_examples"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golden_examples" ADD CONSTRAINT "golden_examples_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golden_examples" ADD CONSTRAINT "golden_examples_source_location_id_locations_id_fk" FOREIGN KEY ("source_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golden_examples" ADD CONSTRAINT "golden_examples_source_review_id_human_reviews_id_fk" FOREIGN KEY ("source_review_id") REFERENCES "public"."human_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golden_examples" ADD CONSTRAINT "golden_examples_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golden_examples" ADD CONSTRAINT "golden_examples_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golden_examples" ADD CONSTRAINT "golden_examples_retired_by_users_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evaluation_results_run_idx" ON "evaluation_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "evaluation_runs_requested_idx" ON "evaluation_runs" USING btree ("requested_at");--> statement-breakpoint
CREATE INDEX "golden_example_images_example_idx" ON "golden_example_images" USING btree ("example_id","ordinal");--> statement-breakpoint
CREATE INDEX "golden_examples_status_idx" ON "golden_examples" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "golden_examples" ADD CONSTRAINT "golden_examples_supersedes_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."golden_examples"("id");--> statement-breakpoint
-- Golden examples (PRD §55): a DRAFT may be edited; once APPROVED its content is frozen.
-- Allowed status changes: DRAFT → APPROVED, DRAFT → RETIRED, APPROVED → RETIRED. Never deleted.
CREATE OR REPLACE FUNCTION alvip_golden_example_guard() RETURNS trigger AS $$
DECLARE
  content_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'golden_examples rows cannot be deleted; retire instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  content_changed := (to_jsonb(NEW) - 'status' - 'approved_by' - 'approved_at' - 'retired_by' - 'retired_at' - 'retire_reason')
    IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'approved_by' - 'approved_at' - 'retired_by' - 'retired_at' - 'retire_reason');
  IF OLD.status <> 'DRAFT' AND content_changed THEN
    RAISE EXCEPTION 'golden example % is %; its content is frozen', OLD.id, OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'RETIRED'))
    OR (OLD.status = 'APPROVED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'golden example status % → % is not allowed', OLD.status, NEW.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'RETIRED' THEN
    RAISE EXCEPTION 'golden example % is retired', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER golden_examples_guard
  BEFORE UPDATE OR DELETE ON golden_examples
  FOR EACH ROW EXECUTE FUNCTION alvip_golden_example_guard();
--> statement-breakpoint
CREATE TRIGGER golden_example_images_append_only
  BEFORE UPDATE OR DELETE ON golden_example_images
  FOR EACH ROW EXECUTE FUNCTION alvip_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER evaluation_results_append_only
  BEFORE UPDATE OR DELETE ON evaluation_results
  FOR EACH ROW EXECUTE FUNCTION alvip_reject_mutation();
