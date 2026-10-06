ALTER TYPE "public"."audit_event_type" ADD VALUE 'NETSUITE_SYNC_RETRY_REQUESTED';--> statement-breakpoint
ALTER TABLE "netsuite_sync_outbox" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "netsuite_sync_outbox" ADD COLUMN "remote_ref" text;--> statement-breakpoint
ALTER TABLE "netsuite_sync_outbox" ADD COLUMN "already_applied" boolean;--> statement-breakpoint
CREATE INDEX "netsuite_sync_outbox_location_idx" ON "netsuite_sync_outbox" USING btree ("location_id","created_at");