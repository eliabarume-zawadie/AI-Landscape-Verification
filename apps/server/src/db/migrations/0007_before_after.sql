ALTER TYPE "public"."audit_event_type" ADD VALUE 'BEFORE_AFTER_COMPLETED' BEFORE 'EVIDENCE_GENERATED';--> statement-breakpoint
ALTER TABLE "image_analysis" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "image_analysis" ADD COLUMN "stage_certainty" text;--> statement-breakpoint
ALTER TABLE "image_analysis" ADD COLUMN "stage_signals" jsonb;--> statement-breakpoint
ALTER TABLE "image_pairs" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "image_pairs" ADD COLUMN "raw_response" jsonb;--> statement-breakpoint
ALTER TABLE "image_pairs" ADD COLUMN "validation_error" text;--> statement-breakpoint
ALTER TABLE "image_pairs" ADD COLUMN "served_model" text;--> statement-breakpoint
ALTER TABLE "image_pairs" ADD COLUMN "cache_hit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "image_pairs" ADD COLUMN "cost_usd" numeric(12, 6);