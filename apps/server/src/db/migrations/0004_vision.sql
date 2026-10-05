ALTER TYPE "public"."audit_event_type" ADD VALUE 'AI_VISION_COMPLETED' BEFORE 'EVIDENCE_GENERATED';--> statement-breakpoint
CREATE TABLE "vision_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"result" jsonb NOT NULL,
	"served_model" text NOT NULL,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_analysis" ADD COLUMN "validation_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "image_analysis" ADD COLUMN "analysis_status" text;--> statement-breakpoint
ALTER TABLE "image_analysis" ADD COLUMN "served_model" text;