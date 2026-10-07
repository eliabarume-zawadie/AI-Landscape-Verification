# Deployment

**Status:** Dockerfile and docker-compose are provided but **untested** (Docker is not installed on the development machine). Hosting target is unknown (U13).

## Shape

- The reviewer UI is built with `npm run build:web` and served by the API (no separate web server).
- One container image, two roles: `api` (`npm start -w @alvip/server`, with `WORKER_MODE=off` when separate workers run) and `worker` (`npm run worker -w @alvip/server`). Scale workers horizontally; they coordinate through Postgres row locks and leases.
- PostgreSQL 16 (managed in production).
- TLS terminated upstream; `COOKIE_SECURE=true` (enforced).
- Migrations run on API start; for multi-instance deploys run `npm run db:migrate` as a release step.

## Required production environment

`NODE_ENV=production`, `DATABASE_URL`, `MOCK_NETSUITE=false`, `MOCK_AI=false`, `MOCK_IMAGES=false`, `AUTOMATION_LEVEL` (0–3), plus NetSuite credentials once available. For AI: `ALLOW_EXTERNAL_AI_IMAGE_PROCESSING=true` (only after data-processing approval) and credentials for the provider. Anthropic is the default (`ANTHROPIC_API_KEY` or a workload-identity setup); for OpenAI set `VISION_PROVIDER=openai`, `VISION_MODEL=<evaluated model>` and `OPENAI_API_KEY`. Startup fails if any of these safety settings are wrong.

## Local production-like stack

```bash
docker compose up --build
docker compose exec api npm run db:seed
```

## Rollout (PRD §90)

Historical analysis → shadow mode → AI assist → evidence bundling standard → fast track (still human-confirmed). Level 4+ is out of scope for this release.

## Backup and recovery

What must be backed up, and why:

| Data | Where | Notes |
|---|---|---|
| PostgreSQL database | `DATABASE_URL` | Everything that matters: decisions, audit history, feedback, NetSuite outbox, evaluation set, rollout history. Use the managed service's automated backups with point-in-time recovery (recommended: at least 7 days of PITR, daily snapshots kept 30+ days) |
| Evaluation-set photos | storage, `golden/…` keys | Needed to re-run evaluations. Back up with the storage bucket (versioning on) |
| Location photos | storage, `locations/…` keys | Working copies, purged after `IMAGE_RETENTION_DAYS`. The source of truth stays in NetSuite / the photo system, so losing them only means re-fetching |
| Configuration | `config/`, `prompts/` in git | Versioned in source control; the database also keeps every version that was active |

Recovery:
1. Restore the database to the chosen point in time and point `DATABASE_URL` at it.
2. Start one API instance. Migrations run on start; interrupted processing is recovered automatically (expired job leases are re-queued; running analyses restart as new runs; history is kept).
3. Decisions made before the restore point but not yet in NetSuite are still in the outbox and are sent automatically. Decisions made **after** the restore point are lost from ALVIP but may already be in NetSuite: the write-back re-reads NetSuite and will not overwrite them, and they show up as NetSuite problems to reconcile.
4. Test the restore procedure on a copy before go-live and at least twice a year.

Local development (PGlite) has no backups: copy the folder printed as `Local data:` while the server is stopped.

## Production readiness (PRD §92)

| Item | Status |
|---|---|
| NetSuite integration validated | **Open**: production adapter blocked on access (U1–U6). Mock-tested write-back, retries and idempotency |
| Authentication secured | Done: hashed passwords, server-side sessions, secure cookies enforced in production, login throttling, role checks on every route (automated test covers all routes). SSO open (U12) |
| Image access secured | Done: private storage, authenticated and location-scoped image routes, no public URLs, views audited |
| AI provider reliability tested | **Partly**: retries, fallbacks, malformed/refused output handling tested with mocks; needs a live trial with the chosen provider |
| Golden dataset created | **Open**: tooling done; needs labelled historical cases (U11) |
| AI evaluation completed / false approval & rejection rates measured | **Open**: runner and report done; needs the real dataset |
| Human override rate measured | Ready: dashboard + shadow results measure it from live use |
| Cost per location measured | Ready: tracked per run; needs a live provider to be meaningful |
| Performance under expected volume tested | **Open**: 170-photo location tested; no sustained-volume test yet (needs the hosting target, U13) |
| Retry mechanisms tested | Done: queue, image, AI and NetSuite retries covered by tests |
| Audit logging validated | Done: append-only (database-enforced), complete per-location history |
| Backup/recovery strategy documented | Documented above; to be tested on the chosen hosting |
| Human review workflow approved by business owner | **Open**: needs a walk-through with the business owner |
