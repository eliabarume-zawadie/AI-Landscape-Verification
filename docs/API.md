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

### Phase 5

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/locations/:id/evidence` | REVIEWER | `?runId=` (default current). Per service: `status`, `confidence`, `humanRequired`, `reasons`, `explanation`, `components`, `supporting`/`contradicting`/`context` items (`ref`, `evidenceType`, `strength` as HIGH/MEDIUM/LOW, `observation`), `contradictions` with image refs. Never returns raw scores |

### Phase 6

- `GET /api/locations/:id/evidence` now also returns `pairs`: `status`, `beforeRef`/`afterRef` (+ image IDs), `sameAreaConfidence` (band), `notes`, `changes` (`service`, `direction`, `strength` band, `description`). Confirmed pairs first.
- `GET /api/locations/:id/images` analysis now includes `stage`, `stageCertainty`, `analysisStatus`.

### Phase 7

- `GET /api/locations/:id/evidence` adds `bundle: { totalImages, entries: [{ imageId, ref, rank, reasons, services: [{ service, role }] }] }` and, per service, `bundle: [{ imageId, ref, roles }]`.
- `GET /api/locations/:id/images?order=evidence` returns images strongest-evidence first; each item has `inBundle` and `analysis.evidenceRank`; `summary.inBundle`.

### Phase 8

- `GET /api/locations` adds filters `risk` (LOW/MEDIUM/HIGH) and `recommendation`, sort `risk`; items include `riskLevel`, `aiRecommendation`.
- `GET /api/queue/summary` adds `awaitingReviewByRisk`.
- `GET /api/locations/:id/evidence` adds `recommendation { value, explanation, lane }` and `risk { level, factors: [{ factor, detail }] }`.

### Phase 9

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/review/next` | REVIEWER | `?lane=HUMAN_REVIEW\|FAST&after=<id>` → `{ locationId }` oldest awaiting (team leads also get ESCALATED) |
| POST | `/api/locations/:id/review/open` | REVIEWER | audits REVIEW_OPENED → `{ openedAt }` |
| POST | `/api/locations/:id/review` | REVIEWER | body `{ decision: APPROVE\|REJECT\|ESCALATE, serviceDecisions?, reasonCode?, reasonText?, evidenceViewed?, openedAt? }` → 201 `{ reviewId, status, isOverride, conflicts }`. 422 `REASON_REQUIRED` when going against the AI without a reason; 403 when a reviewer decides an escalated location; 409 when already decided |
| GET | `/api/locations/:id/reviews` | REVIEWER | decision history with reviewer names |
| POST | `/api/review/fast-lane/confirm` | REVIEWER | `{ locationIds[], openedAt? }`; automation level 3 only (409 otherwise); 422 `NOT_FAST_LANE` if any location is not a Fast Lane approve recommendation |

### Phase 10

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/locations/:id/review` | REVIEWER | adds `relevantImageIds?` (≤ 10 photos of this location, needs `reasonCode`). Whenever a reason is given, feedback rows are written (one per disagreeing service, or one location-level row, × each flagged photo). Response adds `feedbackRows` |
| GET | `/api/locations/:id/reviews` | REVIEWER | each review now includes its `feedback` rows |
| GET | `/api/locations/:id` | REVIEWER | audit entries now include `actorName` |
| GET | `/api/feedback` | TEAM_LEAD | `?from&to&reason&service&reviewer&overridesOnly&limit&offset` → `{ rows, summary: { total, byReason, byService } }` |
| GET | `/api/feedback/export.csv` | TEAM_LEAD | same filters, up to 50,000 rows; audited as `FEEDBACK_EXPORTED`; cells that a spreadsheet would run as formulas are prefixed with `'` |
| GET | `/api/knowledge` | REVIEWER | `?q&clientId&serviceCode&kind&includeArchived` → `{ notes }` (every word must match title or text) |
| GET | `/api/knowledge/scopes` | REVIEWER | clients and active services for filters/forms |
| GET | `/api/locations/:id/knowledge` | REVIEWER | active notes for the location's client (or all) and its services (or all), most specific first, max 10 |
| POST | `/api/knowledge` | TEAM_LEAD | `{ kind, title, body, clientId?, serviceCode?, source? }` → 201 `{ note }` |
| POST | `/api/knowledge/:id/revise` | TEAM_LEAD | same body; archives the old note and creates a superseding one; 409 if already archived |
| POST | `/api/knowledge/:id/archive` | TEAM_LEAD | `{ reason }`; 409 if already archived |

### Phase 11

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/locations/:id/netsuite` | REVIEWER | `{ writes: [{ operation, status, attempts, lastError, lastErrorCategory, lastAttemptAt, syncedAt, remoteRef, alreadyApplied }] }` |
| POST | `/api/locations/:id/netsuite/retry` | TEAM_LEAD | only from `NETSUITE_ERROR` (409 otherwise); re-queues unsent writes → 202 `{ jobId }`; audited |

`POST /api/locations/:id/review` with APPROVE/REJECT now also queues the NetSuite write in the same transaction (see docs/NETSUITE_INTEGRATION.md).

Non-API GETs return the reviewer UI (`index.html`) when `WEB_DIST_DIR` exists.

## Planned (PRD §76)

| Method | Path | Phase |
|---|---|---|
| GET | `/api/dashboard`, `/api/analytics` | 12 |
