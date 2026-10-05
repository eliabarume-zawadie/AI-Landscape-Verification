# Changelog

## [0.2.0] — Phase 2: Queue & location processing — 2026-10-05

### Added
- **Postgres job queue** (`PgQueue`): idempotency keys, `FOR UPDATE SKIP LOCKED` claims (priority, then oldest first), leases with heartbeat, PRD §78 retry policy (exponential backoff with jitter for TRANSIENT/MODEL_ERROR; immediate dead-letter for auth/validation/config/invalid image), max attempts, expired-lease recovery. Enqueue joins the caller's transaction.
- **Mock NetSuite adapter** with 16 scenarios covering all 10 demonstration cases plus fertilization, unknown client, unknown service, no images, flaky image listing, and a 170-image location. Failure injection, idempotent writes, images that appear on a later fetch.
- **Ingest** (`ingestQueue`): idempotent by NetSuite ID. Services come from the source system, else the client profile. Unknown clients, unknown service codes, and locations with no services go to the Exception Lane (`INTEGRATION_ERROR`) with a recorded error, never silently dropped.
- **Location processor** (`PROCESS_LOCATION` job): crash recovery for interrupted runs, versioned processing runs (service rules, client profile, thresholds, automation level, shadow mode, app version), image reference acquisition, routing to `HUMAN_REVIEW`. Every status change goes through the state machine and is audited.
- **Worker** with bounded concurrency, periodic NetSuite polling, and failure hooks that move locations to the Exception Lane. Runs embedded in the API (required with PGlite) or standalone (`npm run worker`, Postgres only).
- **Reprocessing** (PRD §43): Team Lead+, structured reasons, new run each time, earlier runs preserved; refused while a decision is waiting to sync.
- **Manual-review fallback** for Exception Lane locations (e.g. AI outage).
- API: `GET /api/locations` (filters: status, lane, client, service, text, run ID, date; oldest first), `GET /api/locations/:id` (services, images, runs, audit trail, open errors), `POST /api/locations/:id/reprocess`, `POST /api/locations/:id/manual-review`, `POST /api/jobs/location/:id`, `GET /api/jobs/:id`, `GET /api/queue/summary`, `POST /api/admin/ingest`.
- Migration `0002`: `images.locator`.
- `.gitattributes` (LF line endings).

### Not yet (by design)
- No AI analysis runs yet. Each run records `aiAnalysisPerformed: false` and recommends `NEEDS_HUMAN_REVIEW`. Image bytes are not fetched yet (Phase 3).

### Verified
- 114 tests passing (queue semantics, mock adapter, ingest idempotency, exception routing, retries, crash recovery, reprocessing, API filters and RBAC).
- Live run: API + embedded worker auto-ingested 16 mock locations. 13 reached human review, 3 went to the Exception Lane, and the flaky location recovered via real backoff. Queue fully cleared.

### Fixed
- Claimed jobs are now returned in priority/age order (`UPDATE ... RETURNING` does not preserve subquery order).

## [0.1.0] — Phase 1: Foundation — 2026-10-05

### Added
- Workspace scaffold: `apps/server` (Fastify 5, Drizzle, Zod), `packages/shared`, Vitest.
- Environment config with safety guards: `AUTOMATION_LEVEL` > 3 refused; mocks, missing `DATABASE_URL`, and insecure cookies refused in production.
- Versioned, schema-validated configuration:
  - Service registry for all 9 PRD services with evidence types (positive / negative / context), "insufficient alone" lists, and safety notes.
  - Thresholds file flagged **provisional**.
  - Three demo client profiles.
  - Schema-level invariants: equipment can never be sufficient alone; contradictions always need a human.
- Client-profile resolution: before/after precedence; client overrides can only tighten confidence thresholds; fertilization and dead/brown grass default to human review.
- Location state machine (PRD §34 plus `SYNCING`); APPROVED/REJECTED are reachable only from human-review states.
- Full PostgreSQL schema (26 tables) and migrations. Runs on Postgres or embedded PGlite.
- DB-level append-only triggers on `audit_events`, `human_reviews`, `feedback`; versioned config rows are content-immutable.
- Config sync: files → immutable DB versions, idempotent, audited (`CONFIG_CHANGED`).
- Authentication: argon2id passwords (≥12 chars), server-side sessions with SHA-256-hashed tokens, httpOnly SameSite=Strict cookies, login throttling, identical responses for unknown user and wrong password.
- RBAC: Reviewer < Team Lead < Admin.
- Endpoints: health, auth (login/logout/me), services, clients, thresholds, runtime config, admin users.
- Adapter interfaces: `NetSuiteAdapter`, `ImageProvider`, `VisionProvider`, `StorageProvider`, `QueueProvider`.
- Docs skeleton, `.env.example`, Dockerfile, docker-compose.

### Verified
- 61 tests passing (unit + PGlite integration).
- Manual HTTP check: seed → start → login → RBAC 403 → runtime config.
- Startup refuses `AUTOMATION_LEVEL=4`.

### Known limitations
- Docker files are untested (Docker is not installed on the development machine).
- `drizzle-kit` (dev-only) pulls an esbuild version with a moderate advisory affecting its dev server only; not shipped at runtime.
