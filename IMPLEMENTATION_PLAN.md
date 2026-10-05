# ALVIP — Implementation Plan

**Status:** Phases 0–6 complete · Phase 7 next
**Source spec:** [PRD.md](PRD.md) v1.0
**Last updated:** 2026-10-05

This plan turns the PRD into an incremental build. Each phase ends with tests, a review against the PRD, and a CHANGELOG entry. No phase starts while the previous one has known critical failures.

---

## 1. Current architecture (Phase 0 findings)

Repository inspection on 2026-10-05 found:

| Area | Finding |
|---|---|
| Source code | None. The repository contains only `PRD.md`. |
| Version control | Not a git repository. |
| Frameworks / packages / DB / auth / CI / deployment config | None. |
| Existing integrations | None. No NetSuite details, credentials, or sample images are present. |
| Local toolchain | Node 22.23, npm 10.9, Python 3.11, git 2.55. **Docker, PostgreSQL, Redis are not installed.** |
| Host | Windows 11, project directory is inside OneDrive. |

**Conclusion:** This is a new project, so no existing functionality needs to be preserved. The stack below is chosen to fit the PRD's guidance ("simplest architecture that can reliably handle the workload") and this machine's toolchain.

> ⚠️ **OneDrive:** `node_modules` and the local database directory will contain many files that OneDrive will try to sync, which can cause file-lock errors (`EPERM`) during installs. Recommended: mark `node_modules/` and `.data/` as "free up space"/excluded, or move the repo outside OneDrive.

---

## 2. Proposed architecture

### 2.1 Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (Node 22) end-to-end | Type safety (PRD §81); one language for UI, API, workers, and shared domain types. |
| API | Fastify 5 + Zod validation | Small, fast, schema-first; Zod schemas double as AI-output validators. |
| Database | PostgreSQL 16 (prod); **PGlite** (embedded Postgres/WASM) for local dev + tests | Relational/transactional (PRD §81). PGlite runs real Postgres SQL with zero install, so migrations are identical. |
| ORM / migrations | Drizzle ORM + drizzle-kit | Typed SQL, plain-SQL migrations that are reviewable, supports both `pg` and PGlite drivers. |
| Job queue | **Postgres-backed queue** (`FOR UPDATE SKIP LOCKED`) behind `QueueProvider` | See challenge C1. |
| Workers | Separate Node process (`npm run worker`), same codebase | Async processing; horizontally scalable by running more worker processes. |
| Image processing | `sharp` (libvips) | Format validation, decode, blur (Laplacian variance), exposure stats, perceptual hash (dHash), thumbnails. |
| Vision AI | `VisionProvider` interface; `MockVisionProvider` first; production provider chosen by evaluation | PRD §16: model-agnostic. |
| Frontend | React + Vite + TypeScript | Reviewer workspace + team-lead dashboard. Served by the API in production (single deployable). |
| Auth | Local accounts (argon2id) + server-side sessions in Postgres + httpOnly cookies + RBAC; `AuthProvider` seam for SSO | No IdP information exists yet (see unknowns). |
| Tests | Vitest (unit, integration on PGlite, API-level e2e via Fastify `inject`); Playwright for UI smoke later | |
| Deployment | Dockerfile + docker-compose (postgres, api, worker) | Provided for target environments; not runnable on this machine today. |

### 2.2 Logical architecture

```text
            ┌─────────────── apps/web (React) ────────────────┐
            │ Reviewer workspace · Location detail · Dashboard │
            └───────────────────────┬──────────────────────────┘
                                    │ REST (session cookie)
┌───────────────────────────────────▼───────────────────────────────────┐
│ apps/server — API process                                             │
│  modules/ (HTTP routes, authz)  →  services/ (use-cases)               │
│                                     │                                 │
│  domain/ (PURE, no I/O):  service registry · client profiles ·        │
│     state machine · quality rules · evidence aggregation ·            │
│     diversity · risk · contradictions · recommendation · lanes        │
│                                     │                                 │
│  integrations/ (adapters):  NetSuiteAdapter · ImageProvider ·         │
│     VisionProvider · StorageProvider · QueueProvider                  │
│  audit/  ·  db/ (Drizzle schema + migrations)                         │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ verification_jobs table
┌───────────────────────────────────▼───────────────────────────────────┐
│ apps/server — Worker process(es)                                      │
│  pipeline: ingest → format → quality → dedup → relevance → service    │
│            analysis → pairing → before/after → evidence → contradiction│
│            → risk → bundle → recommendation → AI_REVIEW_READY         │
│  netsuite-sync: outbox drain with retry/backoff                       │
│  retention: purge image bytes past retention window                   │
└───────────────────────────────────────────────────────────────────────┘
```

**Key rule:** the vision model only produces **observations** (validated JSON). Everything that turns observations into a status, risk level, lane, or recommendation is **deterministic, versioned, unit-tested code** in `domain/`. An LLM never emits the final service status or the approval.

### 2.3 Repository layout

```text
apps/server/src/
  config/          env schema (Zod), config loading, automation-level guard
  db/              schema.ts, client (pg | pglite), migrations/, seed
  domain/          pure business logic + unit tests
  integrations/    netsuite/ images/ vision/ storage/ queue/  (interface + mock + prod)
  pipeline/        worker stages (I/O orchestration around domain/)
  services/        application use-cases (review, reprocess, sync…)
  modules/         Fastify route plugins (auth, locations, reviews, dashboard, admin)
  audit/           append-only audit writer
apps/web/          React UI
packages/shared/   enums + Zod DTOs shared by server and web
config/            services.json, client-profiles/*.json, thresholds.json  (versioned)
prompts/           image_analysis_v1.md, before_after_v1.md  (versioned)
fixtures/          mock scenarios + generated test images
docs/              ARCHITECTURE, API, DATABASE, AI_PIPELINE, AI_EVALUATION,
                   NETSUITE_INTEGRATION, SECURITY, DEPLOYMENT, TROUBLESHOOTING
README.md · IMPLEMENTATION_PLAN.md · CHANGELOG.md   (repo root)
```

---

## 3. Challenges to the PRD (decisions taken, business intent preserved)

| # | PRD position | Issue | Decision |
|---|---|---|---|
| C1 | Generic "Job Queue" (commonly Redis/BullMQ) | 500 locations/day ≈ 1 job/min; tens of thousands of images/day ≈ <1 image/sec. A second datastore adds ops burden and splits transactional state (a job can be "done" in Redis but not in Postgres). | **Postgres-backed queue** with leases, attempts, exponential backoff, idempotency keys, dead-letter → Exception Lane. Enqueue happens in the same transaction as state changes. `QueueProvider` interface allows swapping later. |
| C2 | §58 lists `evidence_aggregation_v1` and `contradiction_v1` prompts | If an LLM aggregates evidence or decides contradictions, the safety-critical step becomes non-deterministic, hard to test, and hard to audit. | **Aggregation, contradiction detection, risk, and recommendation are deterministic code.** The LLM produces per-image observations — including *negative* observations (e.g. "unmowed section visible") — and per-pair change descriptions. Contradictions are computed from those. An optional LLM "second-opinion" contradiction search can be added later as *additional* signal that can only raise risk, never lower it. |
| C3 | §34 single linear state list (master prompt uses `SYNCING`/`ERROR`; PRD uses `SYNCED_TO_NETSUITE` + 4 error states) | One status field can't represent "decision made, but NetSuite sync failing" without losing the decision. | `locations.status` uses the PRD states plus `SYNCING`; the PRD's specific error states (`IMAGE_ERROR`, `AI_ERROR`, `NETSUITE_ERROR`, `INTEGRATION_ERROR`) are kept. The decision lives in `human_reviews` (immutable) and the write lives in a **transactional outbox** (`netsuite_sync_outbox`), so a sync failure never loses or changes the decision. |
| C4 | §36 "Fast Lane" + §53 Level 3 "human confirmation remains required" | "Fast lane" could be misread as auto-approve. | Fast Lane = **batch-confirmation UI** (reviewer sees evidence summary for several low-risk locations and confirms each). Still a recorded human decision per location. |
| C5 | §17 example shows `evidence_strength: 0.92` | Raw LLM scores are uncalibrated. | Stored internally; mapped to HIGH/MEDIUM/LOW bands via configurable thresholds (PRD §33). Numbers are never shown to users until calibrated. |
| C6 | §53 automation levels 0–5 | Level 4/5 must not be enable-able by config typo. | `AUTOMATION_LEVEL` > 3 is **rejected at startup**; there is no code path that writes an APPROVED decision without a human actor. |
| C7 | §89 shadow mode — "human continues the normal process" | If humans keep deciding inside NetSuite, we need to read their decisions back (unknown fields). | Recommended: shadow mode = **blind review in ALVIP** (AI output hidden from reviewer, recorded separately). Fallback: read decisions back from NetSuite once field IDs are known. |
| C8 | §98 lists docs at repo root | 12 files at root clutter the repo. | README, IMPLEMENTATION_PLAN, CHANGELOG at root; the rest in `docs/`. |
| C9 | PRD §65 "Phase 1" (foundation incl. dashboard) vs §97 phase sequence | Two different phase numberings. | Follow §97 / master-prompt numbering (Phases 0–15). |

---

## 4. Existing functionality to preserve

None (new project). `PRD.md` is preserved unchanged.

---

## 5. New components required

| Component (PRD §8) | Module | Phase |
|---|---|---|
| Config + service registry + client profiles | `config/`, `domain/services`, `domain/clientProfiles` | 1 |
| Auth + RBAC | `modules/auth`, `services/auth` | 1 |
| Audit log (append-only) | `audit/` + DB trigger | 1 |
| Location state machine | `domain/locationState` | 1 (definition) / 2 (use) |
| Queue Orchestrator + workers | `integrations/queue`, `pipeline/` | 2 |
| NetSuite adapter (interface + mock) | `integrations/netsuite` | 2 (read) / 11 (write) |
| Image acquisition, format, quality, dedup | `integrations/images`, `domain/quality`, `domain/dedup` | 3 |
| Vision provider (interface, mock, prompt registry, schema validation) | `integrations/vision`, `prompts/` | 4 |
| Service evidence engine | `domain/evidence` | 5 |
| Before/after pairing + comparison | `domain/pairing`, vision pair call | 6 |
| Evidence bundler + ranking + diversity | `domain/bundle` | 7 |
| Risk engine + contradiction detector + recommendation + lanes | `domain/risk`, `domain/contradictions`, `domain/recommendation` | 8 |
| Reviewer workspace + location detail + search | `apps/web` | 9 |
| Human override + feedback capture + knowledge base | `services/review`, `domain/knowledge` | 10 |
| NetSuite outbox sync | `services/netsuiteSync` | 11 |
| Dashboard + analytics + cost tracking | `modules/dashboard` | 12 |
| Golden dataset + evaluation runner | `eval/` | 13 |
| Shadow mode | config + review UI | 14 |
| Rollout tooling (per client/service enablement, QC sampling) | | 15 |

---

## 6. Database changes

New schema (PostgreSQL). Covers every PRD §72 entity plus the outbox, sessions, and config versioning.

| Table | Purpose / notes |
|---|---|
| `users`, `sessions` | Accounts, roles (`REVIEWER`, `TEAM_LEAD`, `ADMIN`), server-side sessions (hashed token). |
| `clients` | Client master (external NetSuite ref). |
| `client_profiles` | **Versioned, immutable** profile rows (`client_id`, `version`, `profile` jsonb, `is_active`). Editing = new version. |
| `services` | Service registry (code, display name, active). |
| `service_rule_versions` | **Versioned, immutable** rule sets for all services (`version`, `rules` jsonb, `is_active`). |
| `threshold_versions` | Versioned risk/confidence thresholds, flagged `provisional`. |
| `locations` | One row per NetSuite location-visit (`external_id`, client, status, lane, priority, received_at, current_run_id). |
| `location_services` | Required services per location (+ source: NetSuite / client-profile). |
| `images` | Per image: external ref, filename, ordinal, captured_at, sha256, perceptual hash, format, size, storage key, `purged_at`. |
| `processing_runs` | Unique run per (re)processing: run_number, reason, versions (provider, model, model version, prompt, service rules, client profile, thresholds, app), cost, timing. **Never updated after completion.** |
| `image_analysis` | Per run × image: quality (score, usable, issues), duplicate group, observations (validated JSON), raw response, cache hit, cost, latency. |
| `image_pairs` | Per run: before/after candidates, pairing score + signals, change analysis. |
| `evidence` | Per run × service × image: role (SUPPORTING / CONTRADICTING / CONTEXT), strength band, rank, observation text. |
| `service_assessments` | Per run × service: status (5 states), confidence band, internal score, human_required, reasons, explanation. |
| `risk_assessments` | Per run: level, internal score, factors. |
| `contradictions` | Per run × service: supporting vs contradicting image + description. |
| `verification_jobs` | The queue (type, payload, status, priority, run_at, attempts, lease, idempotency_key). |
| `human_reviews` | **Immutable** decision records: AI recommendation snapshot, decision, per-service decisions, override flag, reason code + text, evidence viewed, timings, shadow flag. |
| `feedback` | Per-service/per-image override feedback (structured reason codes from PRD §30). |
| `netsuite_sync_outbox` | Pending/failed/succeeded NetSuite writes with idempotency key and retry state. |
| `audit_events` | **Append-only** (DB trigger blocks UPDATE/DELETE). |
| `prompt_versions`, `model_versions` | Registry of prompt templates (content hash) and model configs. |
| `system_errors` | Categorised errors (TRANSIENT / AUTH / INVALID_IMAGE / MODEL / NETSUITE_VALIDATION) feeding the Exception Lane. |
| `knowledge_notes` | Historical reviewer notes (Phase 10). |
| `golden_examples`, `evaluation_runs` | Phase 13. |

---

## 7. External integrations required

| Integration | Interface | Mock | Production |
|---|---|---|---|
| NetSuite (queue, location, services, write-back) | `NetSuiteAdapter` | `MockNetSuiteAdapter` (scenario fixtures, failure injection) | `RestNetSuiteAdapter` — **blocked on details** (see §13) |
| Images | `ImageProvider` | `MockImageProvider` (generated JPEGs per scenario incl. blurry/dark/corrupt/duplicate) | `NetSuiteImageProvider` / `ExternalUrlImageProvider` — **blocked on storage mechanism** |
| Vision AI | `VisionProvider` | `MockVisionProvider` (deterministic scripted observations; can inject malformed output / outage) | First real adapter after provider evaluation (see §8) |
| Storage | `StorageProvider` | Local filesystem (`.data/`) | S3-compatible or Azure Blob — **depends on hosting** |
| Queue | `QueueProvider` | — | Postgres queue (same in all envs) |

Mock flags: `MOCK_NETSUITE`, `MOCK_AI`, `MOCK_IMAGES` (all default `true` locally; production startup refuses mocks when `NODE_ENV=production`).

---

## 8. AI provider abstraction

```ts
interface VisionProvider {
  readonly info: { provider: string; model: string; modelVersion: string };
  analyzeImages(req: ImageAnalysisRequest): Promise<ImageAnalysisResult[]>;   // batch
  comparePair(req: PairComparisonRequest): Promise<PairComparisonResult>;
}
```

- Prompts live in `prompts/*.md`, versioned by filename and content hash, registered in `prompt_versions`.
- Requests carry **only** the location's required services and the active service rule text (incl. safety rules: equipment ≠ proof, healthy grass ≠ fertilization, change ≠ proof).
- Every response is validated against a Zod schema. Invalid/malformed → one retry → image marked `UNABLE_TO_DETERMINE` for that run (never treated as positive evidence) and logged.
- Results cached by `(sha256, prompt_version, model_version, service_rules_version, services)`.
- Progressive analysis: pixel-level quality + dedup first (free), then one vision call per *unique usable* image (batched), then pair comparisons only for candidate pairs on services that require before/after.
- Provider selection: run the golden dataset (Phase 13) across candidate providers; choose on false-approval rate first, then cost/latency. Images must not be sent to any third-party provider until privacy/DPA approval (unknown U9).

---

## 9. NetSuite integration strategy

1. **Now:** define `NetSuiteAdapter` around business operations (not NetSuite records): `getQueue`, `getLocation`, `getRequiredServices`, `getImages`, `updateVerification`, `addVerificationNote`. Mock implementation drives all development.
2. **Field mapping is configuration** (`NETSUITE_FIELD_MAP` JSON / config file), not code. No field IDs are invented; the production adapter refuses to start with an incomplete mapping.
3. **Reads:** poll a configured saved search / SuiteQL query on a schedule; upsert by NetSuite internal ID (idempotent ingest).
4. **Writes:** transactional outbox. Human decision + outbox row committed together; a worker drains the outbox with an idempotency key, exponential backoff for transient errors, stop-and-alert for auth errors, and admin intervention for validation errors. Before writing, re-read the NetSuite record to confirm it hasn't been decided elsewhere.
5. **Production adapter is blocked** on the details in §13 (U1–U6). Only that adapter is blocked; everything else proceeds on the mock.

---

## 10. Testing strategy

| Level | Scope | Tooling |
|---|---|---|
| Unit | service registry, client profiles, state machine, quality rules, dedup, evidence aggregation, diversity, contradictions, risk, recommendation, lanes, config guards | Vitest, pure functions |
| Integration | DB migrations + repositories, audit immutability trigger, queue claim/lease/retry, NetSuite mock adapter contract, image provider, vision provider schema validation | Vitest + PGlite (fresh DB per suite) |
| Contract | Every adapter implementation runs the same contract test suite (mock now, production later) | Vitest |
| E2E (API) | Queue → location → images → AI → evidence → risk → review → decision → outbox → NetSuite mock → audit → dashboard, for the 10 demo cases in the master prompt | Fastify `inject` + worker run-to-completion |
| UI smoke | Reviewer workspace happy path | Playwright (Phase 9) |
| AI evaluation | Golden dataset metrics per model/prompt version | `npm run eval` (Phase 13) |

---

## 11. Deployment strategy

- Single container image; two process roles: `api` (serves REST + built web UI) and `worker`.
- PostgreSQL 16 managed instance; migrations run as a release step (`npm run db:migrate`).
- Secrets via environment / secret manager only; `.env` git-ignored; `.env.example` committed.
- HTTPS terminated at the platform/load balancer; secure cookies enforced in production.
- `docker-compose.yml` for a production-like local stack where Docker is available.
- Rollout follows PRD §90: historical → shadow → assist → bundling → fast track. Level 4+ is out of scope.

---

## 12. Assumptions (provisional — confirm or correct)

| # | Assumption |
|---|---|
| A1 | Web application used on desktop browsers by an internal team. |
| A2 | Unit of work = one NetSuite **location visit** (location + service date); the same physical location can reappear on later days as a new work item. |
| A3 | Final decision is recorded **per location** with optional per-service decisions underneath. |
| A4 | Decision vocabulary `APPROVE / REJECT / ESCALATE` (configurable labels). |
| A5 | Local username/password auth is acceptable until an SSO provider is named. |
| A6 | Images can be fetched server-side and processed transiently; bytes are deleted after a configurable retention window (default 30 days, provisional); hashes/metadata/analysis are kept. |
| A7 | All numeric thresholds shipped in `config/thresholds.json` are **provisional placeholders** marked as such, to be set from evaluation data. |
| A8 | Fertilization defaults to human review for every client (PRD §61). |
| A9 | Default queue ordering = oldest `received_at` first. |
| A10 | Timezone for "today" metrics is configurable (default `America/New_York`, provisional). |
| A12 | A NetSuite work item with an unknown client, unknown service code, or no services is never partially verified: it goes to the Exception Lane. |
| A13 | Reviewers can see all locations until reviewer assignment is defined (PRD §52 "view assigned locations"; assignment model unknown). |
| A14 | Image bytes are purged only for locations that are `COMPLETED` or `SYNCED_TO_NETSUITE`; a location sitting in review longer than the retention window keeps its images until it finishes. |
| A15 | Crews likely submit iPhone **HEIC** photos (confirmed by business, 2026-10-05). Accepted formats: JPEG, PNG, WebP, HEIF (incl. AVIF and HEVC HEIC). sharp cannot decode HEVC HEIC (verified on a real file), so those are decoded with libheif (WebAssembly, `heic-decode`), max 2 concurrent decodes. Pending: test with real crew photos, and check HEVC patent/licensing position with legal (see SECURITY.md). |
| A16 | Default vision provider is Anthropic (`claude-opus-5-5`, effort `high`, refusal fallback on) — set by the business 2026-10-05. OpenAI is switchable (`VISION_PROVIDER=openai` + explicit `VISION_MODEL`). The production model should still be confirmed by golden-dataset evaluation (Phase 13). Fallbacks can change the serving model, so the served model is recorded per image and evaluation must group by it. |
| A17 | Images are sent one per request at ≤1568 px. Batching several images per request, or the Batch API (async, lower cost), are possible later optimisations once accuracy is measured. |
| A18 | Evidence rules (provisional, documented in AI_PIPELINE.md): absence of evidence is never NOT_SUPPORTED; HIGH confidence needs ≥ 2 independent images; a requirement that has not been evaluated blocks SUPPORTED; a client's per-service confidence override can only tighten. |
| A19 | Before/after stage comes only from filename words and capture times (needs crews to name photos or cameras to keep timestamps — confirm with real data, U8). Without either, before/after cannot be established and services that require it stay INSUFFICIENT. |
| A20 | Before/after pairing and distinct-area checks use extra vision calls (≈ 1 per before-photo plus a few per location, capped by `pairing.max_pair_calls`). Cost impact to be measured on real data. |
| A11 | A client profile can make a service's confidence threshold **stricter** but never looser than the service default. Any rule requiring human review (service default, client-wide, client per-service) wins. |

---

## 13. Known unknowns (needed from the business / NetSuite admin)

| # | Unknown | Blocks |
|---|---|---|
| U1 | NetSuite account ID, sandbox availability, auth method (TBA OAuth 1.0 vs OAuth 2.0 M2M), integration role & permissions | Production NetSuite adapter |
| U2 | Record type(s) for queue/location visits; saved search or SuiteQL that defines "the queue" | Production NetSuite adapter |
| U3 | Field IDs for client, required services, image references, verification status, reviewer, notes | Production NetSuite adapter |
| U4 | Where images live (NetSuite File Cabinet? external URLs? third-party app?) and how they're authenticated | Production image provider |
| U5 | Allowed write-back values and semantics (what does "Reject" trigger downstream?) | Outbox payload mapping |
| U6 | NetSuite concurrency/governance limits | Sync worker rate limits |
| U7 | Per-client service definitions: what visual evidence is sufficient; what "Dead/Brown Grass" requires (report it? treat it? replace it?); how "Landscape Maintenance" decomposes per client | Client profiles (real), evidence rules |
| U8 | Before/after convention: are photos labelled/tagged? Is EXIF/timestamp preserved? | Pairing signal weighting |
| U9 | Approval to send client images to a third-party AI API (DPA, data residency) | Production vision provider |
| U10 | Historical reviewer notes: format and location | Knowledge base import |
| U11 | Labelled historical examples for the golden dataset | Evaluation, provider selection, any automation |
| U12 | SSO / identity provider | Production auth |
| U13 | Hosting target (cloud/on-prem), object storage | Deployment, StorageProvider |
| U14 | Image retention policy | Retention job default |
| U15 | Team size, reviewer shifts, daily cut-off time | Dashboard "today" semantics, capacity metrics |

---

## 14. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| LLM vision hallucinates evidence | False approval | Observations-only model output; deterministic aggregation; contradictions & risk can only add caution; no auto-approval; golden-set false-approval tracking. |
| Uncalibrated confidence misleads reviewers | Over-trust | Bands not percentages; calibration report in Phase 13. |
| Near-duplicates inflate evidence | False approval | Perceptual-hash clustering; evidence counted per cluster / scene, not per image. |
| Mock-driven development diverges from real NetSuite | Rework | Adapter contract tests; field mapping in config; early sandbox access requested (U1–U3). |
| Real image distribution differs from mock fixtures | Poor accuracy | Golden dataset from real history before any rollout; shadow mode. |
| AI cost at 10k+ images/day | Budget | Hash cache, dedup before AI, batched calls, per-run cost tracking. |
| NetSuite outage during sync | Lost/duplicated writes | Outbox + idempotency key + pre-write re-read. |
| Reviewer automation bias | Rubber-stamping | Shadow/blind mode; QC sampling; show contradictions prominently; override-rate monitoring. |
| OneDrive file locking | Dev friction | Exclude `node_modules/`, `.data/` or relocate repo. |
| Single-node PGlite in dev ≠ prod concurrency | Queue bugs missed | Queue integration tests also runnable against real Postgres via `DATABASE_URL`. |

---

## 15. Phase plan and status

| Phase | Scope | Status |
|---|---|---|
| 0 | Repository & environment inspection, this plan | ✅ Done |
| 1 | Architecture scaffold, config (env, mock flags, automation guard), versioned service registry + client profiles + thresholds, full DB schema + migrations, auth + RBAC, append-only audit, adapter interfaces, location state machine, docs skeleton | ✅ Done (see CHANGELOG 0.1.0) |
| 2 | Postgres queue + workers, NetSuite mock ingest, location processor & state transitions | ✅ Done (CHANGELOG 0.2.0) |
| 3 | Image acquisition, format validation, pixel quality, exact + near-duplicate detection, storage + retention | ✅ Done (CHANGELOG 0.3.0) |
| 4 | Vision abstraction, prompt registry, schema validation, mock provider, caching, cost tracking | ✅ Done (CHANGELOG 0.4.0) |
| 5 | Service evidence aggregation (5-state status) | ✅ Done (CHANGELOG 0.5.0) — includes contradiction detection (needed for the CONTRADICTORY status) |
| 6 | Before/after pairing + comparison | ✅ Done (CHANGELOG 0.6.0) |
| 7 | Evidence ranking, diversity, bundling | ⏳ |
| 8 | Risk engine, location recommendation, lanes (contradiction detection delivered in Phase 5) | ⏳ |
| 9 | Reviewer workspace, location detail, search | ⏳ |
| 10 | Overrides, feedback, knowledge base | ⏳ |
| 11 | NetSuite outbox sync (mock; production adapter when U1–U6 are resolved) | ⏳ |
| 12 | Dashboard & analytics (with minimum-sample suppression) | ⏳ |
| 13 | Golden dataset + evaluation runner | ⏳ (needs U11 for real data) |
| 14 | Shadow mode | ⏳ |
| 15 | Controlled rollout tooling | ⏳ |

Each phase's completion is recorded in [CHANGELOG.md](CHANGELOG.md).
