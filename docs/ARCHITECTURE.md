# Architecture

See [IMPLEMENTATION_PLAN.md §2–3](../IMPLEMENTATION_PLAN.md) for the full rationale and the PRD challenges (C1–C9).

## Principles

1. **Observations ≠ conclusions.** Vision providers return validated observations. Status, confidence band, risk, lane, and recommendation are computed by deterministic, versioned code in `apps/server/src/domain/`.
2. **No automated final decisions.** APPROVED/REJECTED are reachable only from `HUMAN_REVIEW`/`ESCALATED` (enforced by the state machine and tested). `AUTOMATION_LEVEL` > 3 is refused at startup.
3. **External systems behind interfaces.** `NetSuiteAdapter`, `ImageProvider`, `VisionProvider`, `StorageProvider`, `QueueProvider` live in `apps/server/src/integrations/`. Business logic never imports a concrete provider.
4. **History is never overwritten.** Processing runs are versioned; reviews, feedback, and audit events are append-only at the database level; config rows are immutable versions.
5. **One datastore.** PostgreSQL holds transactional state, the job queue, and the NetSuite outbox (plan C1, C3).

## Layers (apps/server/src)

| Directory | Responsibility | I/O? |
|---|---|---|
| `config/` | Env parsing + guards, config file loading, config ↔ DB versioning | yes |
| `domain/` | Pure business rules: service registry, client-profile resolution, state machine (later: quality, dedup, evidence, risk, contradictions, lanes) | **no** |
| `integrations/` | Adapter interfaces + implementations | yes |
| `services/` | Use-cases (auth now; review, reprocess, sync later) | yes |
| `modules/` | HTTP routes + authorization | yes |
| `http/` | Fastify app, auth plugin, security headers | yes |
| `audit/` | Append-only audit writer | yes |
| `db/` | Drizzle schema, migrations, client, seed | yes |

## Processes

- **api** — `src/main.ts`: REST API (and the built web UI from Phase 9).
- **worker** — claims jobs from `verification_jobs` (`SKIP LOCKED`, leases, retries), runs `PROCESS_LOCATION`, polls the NetSuite queue every `NETSUITE_POLL_INTERVAL_SEC`. Runs embedded in the API (`WORKER_MODE=embedded`, required with PGlite) or as separate processes (`npm run worker -w @alvip/server`, Postgres only). Later phases add the NetSuite outbox drain.

## Location processing (Phase 2)

```text
ingest (poll or POST /api/admin/ingest)
  NEW -> QUEUED + job          (unknown client/service, no services -> INTEGRATION_ERROR)
job PROCESS_LOCATION
  [in-progress? -> fail stale run, -> QUEUED]   crash recovery
  create processing_run (versions recorded) -> DOWNLOADING
  list image refs (0 -> IMAGE_ERROR)
  [Phases 3-8 insert: quality -> dedup -> vision -> pairing -> evidence -> risk]
  -> HUMAN_REVIEW (recommendation NEEDS_HUMAN_REVIEW; aiAnalysisPerformed=false until Phase 4)
failure: retryable -> run FAILED, location -> QUEUED, job backs off
         final     -> run FAILED, location -> IMAGE_ERROR / AI_ERROR / INTEGRATION_ERROR (Exception Lane)
```

## Data flow (target)

```text
NetSuite queue poll → locations (idempotent upsert) → verification_jobs
  → worker: images → quality → dedup → vision observations → pairing → evidence
  → contradictions → risk → recommendation + lane → AI_REVIEW_READY
  → reviewer decision (human_reviews, immutable) + outbox row (same transaction)
  → outbox worker → NetSuite → audit_events → dashboard
```
