CREATE TYPE "public"."knowledge_kind" AS ENUM('REVIEWER_NOTE', 'SERVICE_DEFINITION', 'CLIENT_INSTRUCTION', 'EDGE_CASE', 'WEEKLY_FEEDBACK', 'HISTORICAL_EXAMPLE');--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'KNOWLEDGE_NOTE_CREATED';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'KNOWLEDGE_NOTE_ARCHIVED';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'FEEDBACK_EXPORTED';--> statement-breakpoint
ALTER TABLE "knowledge_notes" ALTER COLUMN "kind" SET DATA TYPE "public"."knowledge_kind" USING "kind"::"public"."knowledge_kind";--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "location_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "reviewer_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "ai_recommendation" "ai_recommendation";--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "ai_confidence" "confidence_level";--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "is_override" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_notes" ADD COLUMN "title" text NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_notes" ADD COLUMN "supersedes_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_notes" ADD COLUMN "archived_by" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_notes" ADD COLUMN "archive_reason" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_run_id_processing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."processing_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_notes" ADD CONSTRAINT "knowledge_notes_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_created_idx" ON "feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "feedback_reason_idx" ON "feedback" USING btree ("reason_code","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_notes_active_idx" ON "knowledge_notes" USING btree ("archived_at","created_at");--> statement-breakpoint
ALTER TABLE "knowledge_notes" ADD CONSTRAINT "knowledge_notes_supersedes_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."knowledge_notes"("id");--> statement-breakpoint
-- Knowledge notes (PRD §31): content is never overwritten. Revising = new note that
-- supersedes the old one. The only permitted change is archiving, once.
CREATE OR REPLACE FUNCTION alvip_knowledge_note_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge_notes rows cannot be deleted; archive instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.archived_at IS NOT NULL
     OR NEW.archived_at IS NULL
     OR (to_jsonb(NEW) - 'archived_at' - 'archived_by' - 'archive_reason')
        IS DISTINCT FROM (to_jsonb(OLD) - 'archived_at' - 'archived_by' - 'archive_reason') THEN
    RAISE EXCEPTION 'knowledge_notes content is immutable; only archiving once is permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER knowledge_notes_guard
  BEFORE UPDATE OR DELETE ON knowledge_notes
  FOR EACH ROW EXECUTE FUNCTION alvip_knowledge_note_guard();
