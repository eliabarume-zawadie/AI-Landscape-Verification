# Changelog

## [0.6.0] — Phase 6: Before/after intelligence — 2026-10-05

### Added
- **Stage labels from metadata only** (`domain/stageClassification.ts`): filename words (before/pre… vs after/post/done…; "progress" = DURING) and capture times. Times are used only when the visit's timeline has one dominant gap (two bursts). STRONG = both agree; conflict → UNKNOWN; no signal → UNKNOWN. Upload order is never used, and nothing is inferred from image content (which would turn real counter-evidence into "baseline").
- **Candidate pairing** (`domain/pairing.ts`): every combination for small locations; otherwise the top-K after-photos per before-photo by a colour-histogram + shift-tolerant structure distance. On mock scenes this distance found the true pair in the top 3 for 44/51 before-photos at the 170-image location (vs 21/51 with structure alone) and for 100% on small locations. Calibrated on synthetic images only; must be re-tuned on real photos.
- **Pair comparison** by the vision model (new prompt `before_after_v1`; `comparePair` on mock, Claude and OpenAI providers): same area? comparable? per-service change `IMPROVED` / `NO_VISIBLE_CHANGE` / `WORSENED`. Strict validation, one retry, cache, cost tracked. Candidates are tried best-first per before-photo and stop at the first confirmed pair; calls are capped per location.
- **Distinct areas verified, not estimated**: a new `same_area_v1` check credits an area only when the model confidently says two confirmed pairs show different areas, up to the client's minimum. Budget reserved for these checks.
- **Evidence engine inputs** (`domain/beforeAfter.ts`):
  - A before-photo's negative evidence is baseline only if the label is STRONG or the photo is in a model-confirmed pair. A weakly labelled, unpaired "before" still counts against the service.
  - Before/after is **established** for a service only with a confirmed pair showing `IMPROVED` **and** qualifying positive evidence in the after-photo itself (visible change is not proof).
  - `NO_VISIBLE_CHANGE` / `WORSENED` becomes counter-evidence on the after-photo.
- `image_analysis.stage/stage_certainty/stage_signals`; `image_pairs` status, raw response, validation error, served model, cache hit, cost; `images.color_hist`; `BEFORE_AFTER_COMPLETED` audit event; evidence API returns `pairs` (confirmed first, bands only); image list returns each photo's stage.
- Thresholds **v4** (provisional): `pairing.*`.
- Migrations `0006`, `0007`.

### Fixed during the phase
- A first version counted distinct areas as connected components of confirmed pairs. On the 170-image scenario it reported 28 areas for 17 zones: an **overcount** that could falsely satisfy a client's area minimum. Replaced with model-verified distinct areas, after confirming that cheap visual features cannot separate areas (same/different distance distributions overlap).
- Pair comparisons could use up the call budget before the area checks; the budget is now reserved.

### Outcomes on mock scenarios
- Demo 1: mowing/edging SUPPORTED/HIGH, shrub pruning SUPPORTED/MEDIUM. Demo 2: all four SUPPORTED/HIGH. Demo 4: CONTRADICTORY (uncut section in an after-photo). Demo 6: SUPPORTED/MEDIUM (duplicates collapse). Demo 9: INSUFFICIENT (before/after show different areas). Fertilization: still never supported from appearance. Every location still goes to human review.

### Verified
- 321 tests passing.

## [0.5.0] — Phase 5: Service evidence engine — 2026-10-05

### Added
- **Evidence engine** (`domain/evidence.ts`, pure and deterministic): one assessment per required service with status `SUPPORTED` / `NOT_SUPPORTED` / `INSUFFICIENT_EVIDENCE` / `CONTRADICTORY` / `UNABLE_TO_DETERMINE`, a confidence band, human-review flag, reason codes, a template explanation naming the images, and the supporting / contradicting / context evidence.
  - Only analysed, usable, cluster-representative images count; each duplicate cluster counts once (25 copies = 1 image).
  - Polarity is taken from the current service rules. Evidence types in `insufficient_alone` never support on their own (equipment, healthy grass, "weeds reduced", "dead grass observed").
  - Strong support + strong counter-evidence → `CONTRADICTORY`, with the supporting/contradicting image pair recorded. Counter-evidence only → `NOT_SUPPORTED`. Absence of evidence → `INSUFFICIENT_EVIDENCE`, never `NOT_SUPPORTED`. AI failed on every usable image → `UNABLE_TO_DETERMINE`.
  - `SUPPORTED` needs evidence at or above the service threshold **and** every requirement met: before/after (when required), client minimum usable images, client distinct-scene coverage. Requirements that later phases evaluate **fail closed** until then.
  - Confidence: HIGH needs ≥ 2 independent images (configurable); weak counter-evidence, failed analyses, or rule-required review force human review.
  - Landscape maintenance is assessed through the client's required components (worst status wins); its own plant-bed evidence can add a contradiction but never upgrade it.
  - Hook for Phase 6: negative evidence in photos identified as *before* photos becomes baseline context instead of contradiction.
- Evidence stage in `EVIDENCE_BUILDING`: persists `service_assessments` (with component statuses), `evidence`, `contradictions` per run; `EVIDENCE_GENERATED` audit event records which stage inputs were evaluated. The vision request now includes the components of decomposed services.
- `GET /api/locations/:id/evidence[?runId=]`: per-service status, confidence, reasons, explanation, evidence (strength as HIGH/MEDIUM/LOW band only), contradictions with image refs. No internal scores.
- Thresholds **v3** (provisional): `evidence.min_independent_images_for_high`, `evidence.counter_evidence_min_strength`.
- Migration `0005`: `service_assessments.components`.

### Known, by design until Phase 6
- Before/after and scene coverage are not evaluated yet, so services that require them are `INSUFFICIENT_EVIDENCE` (reason `BEFORE_AFTER_NOT_YET_EVALUATED`), and before photos' negative evidence (e.g. tall grass) currently reads as a contradiction (demo cases 1, 4, 6 → `CONTRADICTORY`). Both err toward human review, never toward approval.

### Verified
- 273 tests passing, including 28 engine unit tests (one per rule: duplicates, context-only, fertilization, weeds, dead grass, contradiction, fail-closed requirements, decomposition, before-photo baseline, determinism) and pipeline/API integration tests.

## [0.4.1] — Switchable vision provider — 2026-10-05

### Changed
- `VISION_PROVIDER` now defaults to **`anthropic`** (model `claude-opus-5-5` unless `VISION_MODEL` is set). `MOCK_AI=true` remains the local default.

### Added
- `OpenAIVisionProvider` (`openai` SDK, Chat Completions, strict JSON-schema output, image detail `high`). Select with `VISION_PROVIDER=openai`; `VISION_MODEL` is required (no OpenAI model is assumed). Refusals and content filtering are recorded as `REFUSED`; truncated/non-JSON output goes to the validator like any provider; SDK errors map to the retry policy. `OPENAI_BASE_URL` allows OpenAI-compatible endpoints.
- Both real providers still require `ALLOW_EXTERNAL_AI_IMAGE_PROCESSING=true`.
- Tests: OpenAI adapter against a stubbed client; provider selection (default, switch, missing model, unknown provider, approval guard for each provider). No real OpenAI or Anthropic call has been made.

## [0.4.0] — Phase 4: AI vision abstraction — 2026-10-05

### Added
- **Observation contract** (`domain/observations.ts`): the vision model may report relevance, visibility issues (`OBSTRUCTED`, `TOO_DISTANT`, `IRRELEVANT`), a scene summary, per-service observations `{service, evidence_type, strength, description}`, and services it cannot assess. There is no field for a status, confidence level, recommendation or approval.
- **Validation of every response** against the structure and the active service registry. Unrequested services, evidence types not defined for that service (hallucinated categories), out-of-range strengths, empty descriptions, and any evidence on an image the model itself called irrelevant are dropped and recorded as warnings. Polarity always comes from the registry, never from the model. A malformed response is retried once, then recorded as `MALFORMED`.
- **Versioned prompt** `prompts/image_analysis_v1.md` with the PRD §60 rules (no invisible evidence, no inferred work, equipment ≠ completion, healthy grass ≠ fertilization, no assumed before/after, actively report negative evidence, say "not assessable" instead of guessing). Service sections are rendered from the active rules. Prompts are registered with a content hash; editing a used version is refused.
- **Vision stage**: only usable, non-duplicate images are sent. Images are resized (HEIC handled) before sending. Results are cached by image hash + prompt + model settings + rules version + services. A refusal is recorded as `REFUSED` (never evidence). Outages and rate limits retry the job with backoff (cached results are not paid twice). If no image gets a valid analysis, the location goes to `AI_ERROR`. Model-reported obstruction/irrelevance marks the image unusable.
- **Workflow**: `DOWNLOADING → ANALYZING → EVIDENCE_BUILDING → AI_REVIEW_READY → HUMAN_REVIEW`. Level 0 still skips AI. The recommendation stays `NEEDS_HUMAN_REVIEW` until the evidence and risk engines exist.
- **Mock vision provider** scripted from scenario signals, with simulated outage (demo case 8), malformed-once, always-malformed, hallucinated evidence type, and refusal.
- **Claude adapter** (`AnthropicVisionProvider`, `@anthropic-ai/sdk`): one image per request, JSON-schema structured output, configurable effort (default `high`), server-side refusal fallback `"default"` (on by default). The model that actually served each image is recorded per image. Cost is computed from `config/model-pricing.json` (left blank for unpriced models). SDK errors are mapped to the retry policy. **Off by default**: it requires `MOCK_AI=false`, `VISION_PROVIDER=anthropic` and `ALLOW_EXTERNAL_AI_IMAGE_PROCESSING=true`.
- Runs record vision provider, model, settings and prompt label (`image_analysis_v1@<hash>`) plus AI cost. Per-image: analysis status, served model, raw response, validation warnings/errors, cache hit, cost, latency. New `AI_VISION_COMPLETED` audit event.
- Migration `0004`: `vision_cache`, `image_analysis.analysis_status/served_model/validation_warnings`.

### Verified
- 227 tests passing. The Claude adapter is tested against a stubbed SDK client (request shape, fallback/served model, pricing, refusal, truncation, error mapping). No real API call has been made.
- Live run: 12 locations through the full AI path, all versions recorded; the outage case retrying with backoff.

## [0.3.1] — HEIC support — 2026-10-05

### Added
- iPhone **HEIC (HEVC)** photos are decoded via libheif/WebAssembly (`heic-decode`) when sharp cannot decode them. Verified on a real HEIC file: sharp alone fails, the fallback decodes it, quality analysis marks it usable, and it is served to reviewers as JPEG. Pixel limit checked from the header before decoding; at most 2 concurrent HEVC decodes.
- Shared `openImage()` used by analysis and image viewing; `quality_metrics.decoder` records which decoder was used.
- Real-file HEIC tests run when `fixtures/heic/sample.heic` is present (not committed; `scripts/fetchHeicFixture.ts`).

### Notes
- New runtime dependency `libheif-js` is LGPL-3.0, and HEVC is patent-encumbered. Both are flagged for legal review in SECURITY.md.

## [0.3.0] — Phase 3: Image ingestion, quality, deduplication — 2026-10-05

### Added
- **Image acquisition stage**: fetches every image through `ImageProvider` (concurrency-limited), stores bytes in private storage, and reuses stored bytes on retry or reprocess. A missing or forbidden image is recorded per image and is not fatal. A transient error retries the job, and bytes fetched so far are kept. A location with no readable image goes to `IMAGE_ERROR`.
- **Pixel quality analysis** (PRD §14), decoded once per image with sharp: format, oriented dimensions, mean luminance, Laplacian-variance sharpness, dark/bright fractions. Issues: `MISSING`, `CORRUPT`, `UNSUPPORTED_FORMAT`, `TOO_LARGE`, `TOO_SMALL`, `BLURRY`, `TOO_DARK`, `OVEREXPOSED` (`OBSTRUCTED`/`IRRELEVANT` reserved for the vision stage). Any issue → unusable. There's a decompression-bomb guard.
- **Duplicate clustering** (PRD §15): exact (SHA-256) plus near duplicates. A near duplicate needs **both** a structural match (64-bit dHash) **and** near-identical pixels (32×32 thumbnail mean absolute difference), so before/after photos of the same scene are never merged. The best usable image represents each cluster; nothing is hidden from reviewers.
- Per-run `image_analysis` rows (quality score, usable, issues, metrics, duplicate group/kind); `processing_runs.unique_image_count`; `IMAGE_QUALITY_ASSESSED` audit event.
- **Mock image provider** rendering deterministic synthetic scenes as real JPEGs (before = rough grass, after = mowing stripes; per-photo camera variation; real blur/dark/overexposed/tiny/truncated/TIFF/missing defects). Includes a calibration script, `apps/server/src/scripts/calibrateMockImages.ts`.
- **Private storage**: `LocalStorageProvider` (atomic writes, path-traversal-safe keys) and `MemoryStorageProvider` for tests.
- **Retention** (PRD §51): worker sweep deletes image bytes older than `IMAGE_RETENTION_DAYS`, only for `COMPLETED`/`SYNCED_TO_NETSUITE` locations. Hashes, metadata and analysis are kept, and an `IMAGES_PURGED` audit event is written.
- API: `GET /api/locations/:id/images` (per-run quality + duplicate analysis, summary), `GET /api/locations/:id/images/:imageId/content?variant=full|thumb` (authenticated, `no-store`; non-browser formats transcoded; full views audited as `EVIDENCE_VIEWED`; 410 once purged; 422 if undecodable).
- Thresholds **v2** (provisional): accepted formats, max bytes, max pixels, pixel-similarity duplicate check. Config files renamed to `config/services.json` / `config/thresholds.json` (version lives inside the file).
- Migration `0003`: `images.fingerprint`, `images.content_type`, `image_analysis.duplicate_kind`, new audit event types.

### Fixed
- sharp's `greyscale()` keeps 3 channels, so sharpness, dHash and fingerprints were being computed on interleaved RGB. All three now use a true single-channel image, with assertions. Found by a new unit test before release.
- `mapLimit` no longer leaves in-flight work running after the first failure.

### Verified
- 178 tests passing.
- Calibration: every injected defect is detected and clean images pass. Demo case 6 collapses 25 near-identical photos into 1 cluster (before photo kept separate at dHash distance 38 vs threshold 10). The 170-image location yields 169 unique clusters. Across all scenarios no cluster mixes before/after or different scenes (tested invariant).
- Live run (API + embedded worker): 249 images fetched, analysed and stored. Queue cleared (13 human review, 3 exceptions). Image served with session, 401 without.

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
