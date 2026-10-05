ALTER TYPE "public"."audit_event_type" ADD VALUE 'EVIDENCE_BUNDLED' BEFORE 'RISK_CALCULATED';--> statement-breakpoint
CREATE TABLE "evidence_bundle_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"image_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"reasons" jsonb NOT NULL,
	"services" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_analysis" ADD COLUMN "evidence_rank" integer;--> statement-breakpoint
ALTER TABLE "evidence_bundle_items" ADD CONSTRAINT "evidence_bundle_items_run_id_processing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."processing_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_bundle_items" ADD CONSTRAINT "evidence_bundle_items_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_bundle_items_run_image_uq" ON "evidence_bundle_items" USING btree ("run_id","image_id");--> statement-breakpoint
CREATE INDEX "evidence_bundle_items_run_rank_idx" ON "evidence_bundle_items" USING btree ("run_id","rank");