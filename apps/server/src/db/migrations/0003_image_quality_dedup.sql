ALTER TYPE "public"."audit_event_type" ADD VALUE 'IMAGE_QUALITY_ASSESSED' BEFORE 'ANALYSIS_STARTED';--> statement-breakpoint
ALTER TYPE "public"."audit_event_type" ADD VALUE 'IMAGES_PURGED' BEFORE 'ANALYSIS_STARTED';--> statement-breakpoint
ALTER TABLE "image_analysis" ADD COLUMN "duplicate_kind" text;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "content_type" text;