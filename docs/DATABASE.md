# Database

PostgreSQL 16 in production; embedded PGlite (same SQL) for local development and tests.
Schema: [apps/server/src/db/schema.ts](../apps/server/src/db/schema.ts). Migrations: `apps/server/src/db/migrations/`.

## Workflow

1. Edit `schema.ts`.
2. `npm run db:generate` → review the generated SQL.
3. `npm run db:migrate` (also runs automatically on API start).
4. Hand-written SQL (triggers etc.): `npx drizzle-kit generate --custom --name <name>` from `apps/server`.

## Integrity guarantees enforced in the database

| Guarantee | Mechanism |
|---|---|
| Audit log is append-only | Trigger rejects UPDATE/DELETE/TRUNCATE on `audit_events` |
| Human decisions are never overwritten | Trigger rejects UPDATE/DELETE on `human_reviews`, `feedback` |
| Config versions are immutable | Trigger allows only `is_active` changes on `client_profiles`, `service_rule_versions`, `threshold_versions`; no deletes |
| One active version | Partial unique indexes on `is_active` |
| Idempotent ingest | Unique `locations.external_id` |
| Idempotent jobs / NetSuite writes | Unique `idempotency_key` on `verification_jobs`, `netsuite_sync_outbox` |
| One result per run | Unique (run, image), (run, service), (run) on analysis/assessment/risk tables |

## Entities

PRD §72 entities plus additions. Every PRD entity is present (`model_versions`, `prompt_versions`, `processing_runs`, etc.).

| Group | Tables |
|---|---|
| Identity | `users`, `sessions` |
| Configuration | `clients`, `client_profiles`, `services`, `service_rule_versions`, `threshold_versions`, `prompt_versions`, `model_versions` |
| Work items | `locations`, `location_services`, `images` |
| Processing (per run) | `processing_runs`, `image_analysis`, `image_pairs`, `evidence`, `service_assessments`, `risk_assessments`, `contradictions` |
| Queue | `verification_jobs` |
| Human review | `human_reviews`, `feedback` |
| Integration | `netsuite_sync_outbox` |
| Ops | `audit_events`, `system_errors` |
| Knowledge | `knowledge_notes` |

## Reprocessing model

A reprocess creates a new `processing_runs` row (`run_number` + 1). All per-run tables key on `run_id`, so earlier results stay queryable. `locations.current_run_id` points to the latest run.

## Retention

`images.purged_at` records when image bytes were deleted from storage under `IMAGE_RETENTION_DAYS` (worker sweep every `RETENTION_SWEEP_INTERVAL_SEC`, finished locations only). Metadata, hashes, and analysis are kept.

## Backup / recovery

Production: managed Postgres point-in-time recovery. Daily logical backup recommended. (To be finalised with the hosting decision, unknown U13.)
