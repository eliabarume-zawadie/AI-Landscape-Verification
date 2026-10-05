# Changelog

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
