CREATE TYPE "public"."rollout_mode" AS ENUM('MANUAL', 'SHADOW', 'ASSIST', 'FAST_TRACK');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'ROLLOUT_CHANGED';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'QC_SAMPLED';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'QC_COMPLETED';--> statement-breakpoint
CREATE TABLE "qc_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"checked_by" uuid,
	"checked_at" timestamp with time zone,
	"verdict" text,
	"correct_decision" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "rollout_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"mode" "rollout_mode" NOT NULL,
	"fast_track_services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"evaluation_run_id" uuid,
	"validated" boolean DEFAULT false NOT NULL,
	"set_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "qc_samples" ADD CONSTRAINT "qc_samples_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_samples" ADD CONSTRAINT "qc_samples_review_id_human_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."human_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qc_samples" ADD CONSTRAINT "qc_samples_checked_by_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollout_settings" ADD CONSTRAINT "rollout_settings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollout_settings" ADD CONSTRAINT "rollout_settings_evaluation_run_id_evaluation_runs_id_fk" FOREIGN KEY ("evaluation_run_id") REFERENCES "public"."evaluation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollout_settings" ADD CONSTRAINT "rollout_settings_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qc_samples_review_uq" ON "qc_samples" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "qc_samples_status_idx" ON "qc_samples" USING btree ("status","sampled_at");--> statement-breakpoint
CREATE INDEX "rollout_settings_client_idx" ON "rollout_settings" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE TRIGGER rollout_settings_append_only
  BEFORE UPDATE OR DELETE ON rollout_settings
  FOR EACH ROW EXECUTE FUNCTION alvip_reject_mutation();
--> statement-breakpoint
-- QC samples: completed once (PENDING → DONE); never changed or deleted afterwards.
CREATE OR REPLACE FUNCTION alvip_qc_sample_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'PENDING' OR NEW.status <> 'DONE'
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.review_id IS DISTINCT FROM OLD.review_id
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.sampled_at IS DISTINCT FROM OLD.sampled_at THEN
    RAISE EXCEPTION 'qc_samples can only be completed once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER qc_samples_guard
  BEFORE UPDATE OR DELETE ON qc_samples
  FOR EACH ROW EXECUTE FUNCTION alvip_qc_sample_guard();
