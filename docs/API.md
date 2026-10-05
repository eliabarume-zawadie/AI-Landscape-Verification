# API

REST/JSON. Auth is a session cookie (`alvip_session`, httpOnly, SameSite=Strict) set by `POST /api/auth/login`.
Errors return `{ "error": "<CODE>" }`. 5xx responses never include internals.

Roles are hierarchical: `REVIEWER` < `TEAM_LEAD` < `ADMIN`.

## Implemented (Phase 1)

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/health` | public | `{status:"ok"}` or 503 `{status:"degraded"}` |
| POST | `/api/auth/login` | public | body `{email, password}` → `{user}` + cookie. 401 `INVALID_CREDENTIALS`, 429 `THROTTLED` |
| POST | `/api/auth/logout` | any | revokes the session |
| GET | `/api/auth/me` | any | `{user}` |
| GET | `/api/services` | REVIEWER | active service registry |
| GET | `/api/clients` | REVIEWER | clients + active profile version; full `profile` for TEAM_LEAD+ |
| GET | `/api/config/thresholds` | TEAM_LEAD | active thresholds (includes `provisional`) |
| GET | `/api/config/runtime` | TEAM_LEAD | automation level, shadow mode, mock flags, app version |
| GET | `/api/admin/users` | ADMIN | list users |
| POST | `/api/admin/users` | ADMIN | body `{email, displayName, role, password(≥12)}` → 201; 409 `EMAIL_EXISTS` |

### Phase 2

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/locations` | REVIEWER | filters `status, lane, client, service, q, runId, receivedFrom, receivedTo`; `sort=oldest\|newest` (default oldest); `limit ≤200, offset` |
| GET | `/api/locations/:id` | REVIEWER | location, services, image metadata (no locators), runs (newest first), audit trail, open errors |
| POST | `/api/locations/:id/reprocess` | TEAM_LEAD | body `{reason: NEW_IMAGES\|IMPROVED_MODEL\|CONFIG_CHANGE\|REVIEWER_DISPUTE\|TECHNICAL_ERROR, note?}` → 202 `{jobId}`; 409 `INVALID_STATE` if not reprocessable |
| POST | `/api/locations/:id/manual-review` | TEAM_LEAD | Exception Lane (`IMAGE_ERROR`/`AI_ERROR`/`INTEGRATION_ERROR`) → `HUMAN_REVIEW` |
| POST | `/api/jobs/location/:id` | TEAM_LEAD | queue a `NEW` location → 202 `{jobId}`; 409 otherwise |
| GET | `/api/jobs/:id` | TEAM_LEAD | job status, attempts, last error |
| GET | `/api/queue/summary` | REVIEWER | counts by status, lane, job status; oldest unprocessed |
| POST | `/api/admin/ingest` | TEAM_LEAD | pull the NetSuite queue now |

### Phase 3

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/locations/:id/images` | REVIEWER | `?runId=` (default current run). Items with `contentAvailable`, `downloadError`, and `analysis {qualityScore, usable, issues, duplicateGroup, isDuplicateRepresentative, duplicateKind}`; `summary {total, usable, unusable, uniqueClusters, duplicates}` |
| GET | `/api/locations/:id/images/:imageId/content` | REVIEWER | `?variant=full\|thumb`. Private, `no-store`. Full views are audited (`EVIDENCE_VIEWED`). 410 if purged, 422 if undecodable, 404 if the image belongs to another location |

## Planned (PRD §76)

| Method | Path | Phase |
|---|---|---|
| GET | `/api/locations/:id/evidence` | 7 |
| POST | `/api/locations/:id/review` | 9 |
| GET | `/api/dashboard`, `/api/analytics` | 12 |
