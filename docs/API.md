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

### Phase 12

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/dashboard` | TEAM_LEAD | `?from&to` (local dates `YYYY-MM-DD` in `METRICS_TIMEZONE`, inclusive, default today, max 366 days) `&client&service&risk&reviewer`. Returns `period, minSample, diagnosis[], queue, timing, ai, efficiency, cost, netsuite, health, reviewers[]`. Every rate is `{ value, numerator, denominator, suppressed }`; `value` is null below `thresholds.metrics.min_sample_size` |
| GET | `/api/dashboard/scopes` | TEAM_LEAD | clients and reviewers for the filters |

### Phase 13

All TEAM_LEAD unless noted. Definitions: docs/AI_EVALUATION.md.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/golden` | `?status=DRAFT\|APPROVED\|RETIRED` → `{ examples }` |
| POST | `/api/golden/from-location/:id` | decided locations only (409 otherwise); copies photos → 201 `{ id }` (draft) |
| POST | `/api/golden/demo` | ADMIN; mock image source only; creates approved demo examples once → `{ created }` |
| GET | `/api/golden/:id` | example with photos |
| PATCH | `/api/golden/:id` | drafts only (409 otherwise): `{ title?, expected?, tags?, reason?, notes? }` |
| POST | `/api/golden/:id/approve` | needs another lead than the creator (403), or an admin |
| POST | `/api/golden/:id/retire` | `{ reason }` |
| GET | `/api/golden/images/:id/content` | `?variant=thumb\|full`, always JPEG |
| GET | `/api/evaluations/vision` | current AI provider info (`external` → runs are billed) |
| GET | `/api/evaluations` | runs with headline metrics |
| POST | `/api/evaluations` | `{ label?, includeDemo?, clientId?, tags?, visionModel? (ADMIN), acknowledgeCost? }` → 202 `{ id }`. 409 while another run is active; 422 with no approved examples in scope; 428 when an external provider is used without `acknowledgeCost` |
| GET | `/api/evaluations/:id` | `{ run (summary, versions), results }` |

### Phase 14

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/shadow` | TEAM_LEAD | `?from&to&client` → `{ enabled, summary: { decisions, agreement, aiApproveHumanReject (with ci95), aiRejectHumanApprove, aiDeferred, byService, byConfidence, aiSecondsMedian, humanSecondsMedian }, items[] }` |

Shadow mode changes existing endpoints for locations whose current run is a shadow run, while the AI is hidden from the caller (always for reviewers; until decided for leads):
- `GET /api/locations`: `riskLevel` and `aiRecommendation` are null; risk and recommendation filters exclude these rows; risk sort puts them last.
- `GET /api/locations/:id`: same fields null; AI audit events have empty data; adds `shadow`, `aiHidden`.
- `GET /api/locations/:id/evidence`: `{ aiHidden: true, services: [], requiredServices }`.
- `GET /api/locations/:id/images`: no evidence rank, bundle membership or vision status; `order=evidence` falls back to upload order.
- `GET /api/queue/summary`: risk counts report these locations as `NONE`.
- `POST /api/locations/:id/review`: no reason required, `isOverride` false, `shadowMode` true.

### Phase 15

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/rollout` | TEAM_LEAD | `{ ceiling, shadowSwitch, default, clients[{ id, code, name, rollout }], qc, qcRates }` |
| GET | `/api/rollout/history` | TEAM_LEAD | `?client=<id>` (omit for the default) |
| POST | `/api/rollout` | ADMIN | `{ clientId \| null, mode: MANUAL\|SHADOW\|ASSIST\|FAST_TRACK, fastTrackServices?, reason, evaluationRunId?, acknowledgeNoValidation? }` → 201 `{ effective, movedOutOfFastLane }`. 409 above the server ceiling; 428 fast track without validation or acknowledgement |
| GET | `/api/qc` | TEAM_LEAD | `?status=PENDING\|DONE` → `{ samples, stats }` |
| POST | `/api/qc/:id` | TEAM_LEAD | `{ verdict: CONFIRMED\|DISAGREE, correctDecision?, note? }`; 403 for the original decider; 409 if already checked |

`POST /api/locations/:id/review` responses add `qcSampled`.

## Dashboard metric definitions (Phase 12)

| Metric | Definition |
|---|---|
| Received | Locations whose `received_at` falls in the period |
| AI processed | Locations with a processing run that succeeded in the period |
| Decided | Approve/reject decisions submitted in the period (escalations counted separately) |
| Completed | Locations that reached `COMPLETED` (decision recorded in NetSuite) in the period |
| Still open now | Right now, regardless of period: before review + awaiting review + photo/AI/data problems |
| Cleared | Decided ÷ (decided + still open). An operational share, shown without a minimum sample |
| Review time | Median of decision time − opening time (Fast Lane batches and sessions over 4 h excluded) |
| Agreed with the AI | Among decisions where the AI recommended approve or reject: the human decided the same. "Can't decide" suggestions are the AI deferring and are reported separately |
| Decisions against the AI | Decisions that needed a reason because they went against the AI (`is_override`) ÷ decisions with an AI assessment |
| "Approve" suggestions rejected | The closest observable signal to false approvals. It is **not** the false approval rate |
| False approval / rejection rate | **Not measured**: needs checked ground truth (golden dataset, Phase 13; QC sampling, Phase 15) |
| Agreement by AI confidence | Per service: SUPPORTED vs a human approve, NOT_SUPPORTED/CONTRADICTORY vs a reject, by the AI's confidence band. Agreement with reviewers, not accuracy |
| Photos analysed | ANALYZED/CACHED ÷ photos sent to the AI (unusable and duplicate photos are not sent) |
| Quality failures | Photos marked unusable ÷ all photos in runs completed in the period |
| Decided without opening every photo | Decisions where fewer photos were opened full size than the location has |
| Time saved | Only when `METRICS_BASELINE_REVIEW_SECONDS` is set: (baseline − mean review time) × decisions |
| AI cost | Sum of run costs for runs completed in the period; per location, per photo, per decided location; by client. Not split per service: one AI call covers all of a location's services |
| NetSuite | Writes created in the period by state; mean write latency |

Rates over fewer than `thresholds.metrics.min_sample_size` (30) cases are returned as `value: null, suppressed: true` and shown as "Not enough data".
