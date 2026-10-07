# Changelog

## [0.15.1] — Final end-to-end review — 2026-10-07

### Review
- **Clean checkout:** fresh clone outside OneDrive. Install, typecheck and UI build succeed with nothing from the developer's machine.
- **Secrets:** none in the git history. Only `.env.example` is tracked.
- **Dependencies:** 0 known vulnerabilities in production dependencies. 4 moderate advisories are confined to the migration generator's bundled esbuild dev server (`drizzle-kit`, development only, never started); left as is because the suggested fix downgrades drizzle-kit.
- **MVP definition of done (PRD §91):** every item exercised end to end on a fresh database in a real browser, as reviewer, team lead and admin. Also covered: feedback, knowledge, Fast Lane with QC sampling, a sandboxed evaluation and a rollout change. No browser errors or server errors.

### Added
- **Route security test:** discovers every API route from the running app and asserts that each one refuses requests without a session, and that every team-lead/admin route refuses a reviewer. A new route without an access check now fails the build.
- **Docs:** the README is rewritten for the finished system (status, Windows commands, roles, where to find what). `docs/DEPLOYMENT.md` gains a backup and recovery strategy and a PRD §92 production-readiness checklist with honest status.

### Fixed
- The dashboard integration test depended on the time of day: mock locations are received up to 10 hours earlier, so between midnight and 10:00 UTC some fell on "yesterday". It now uses a two-day window, and still checks that the default period is today.

## [0.15.0] — Phase 15: Controlled rollout and quality checks — 2026-10-06

### Added
- **Rollout per client** (PRD §71, §90; the Rollout page). Modes are manual (no AI), shadow, AI assists, and fast track for listed services. They are set per client or as a default, by admins, each with a written reason. History is append-only and audited.
  - **Server ceiling:** `AUTOMATION_LEVEL` caps the modes, and `SHADOW_MODE` remains a global switch. Fully automatic approval is not a mode.
  - **Pipeline:** the AI runs, hidden or visible, according to the client's mode. The Fast Lane needs fast track for every required service of the location.
  - **Fast track evidence:** an evaluation on real examples with enough samples and no false approvals, or an explicit business acknowledgement, recorded as "not validated".
  - **Rollback:** narrowing or leaving fast track immediately moves no-longer-eligible Fast Lane locations back to normal review.
- **Quality checks** (PRD §71): a share of approvals is re-checked by a second team lead (10% of Fast Lane confirmations and 2% of other approvals by default, via `QC_SAMPLE_RATE_*`).
  - **Recording:** the checker confirms, or records the correct decision and why.
  - **Rules:** the original decider can't check their own decision, and checks never change it.
  - **Rates:** disagreement rates by sample type and client, with 95% ranges and small-sample suppression.
- Migration `0013`: `rollout_settings` (append-only) and `qc_samples` (completed once), plus audit types. `docs/ROLLOUT.md`.

### Verified
- **Tests:** 10 new covering mode/ceiling rules, Fast Lane eligibility, environment defaults, admin-only changes with reasons, the fast-track validation gate, rollback out of the Fast Lane, the ceiling, per-client shadow and manual runs (no AI calls), QC sampling and the second-person rule, and the database guards.
- **Browser:** an admin set a client to fast track (mowing) with an acknowledgement. A reviewer's approval was sampled, and a lead recorded a disagreement.

## [0.14.0] — Phase 14: Shadow mode — 2026-10-06

### Added
- **Shadow mode** (`SHADOW_MODE=true`, PRD §89 and rollout stage 2): the AI analyses live locations without influencing decisions.
  - **Hidden at the server:** the AI suggestion, risk, service verdicts, explanations, evidence ranking and bundle, before/after notes, and AI audit details are withheld from the people deciding. Reviewers never see them; team leads see them only after the decision. List filters and sorting by risk or suggestion can't reveal them.
  - **Per location:** a location follows the mode of its current processing run, so switching the setting never exposes the AI mid-review.
  - **Review screen:** "Decide from the photos", with the required services and all photos. No reason is required for disagreeing with an AI the reviewer can't see, and it doesn't count as an override.
  - **Silent recording:** with each decision, the AI suggestion and per-service view, where the person differed, and the timings. Nothing is fast-tracked.
- **Shadow results page** (team leads):
  - **Comparison:** agreement, "AI would have approved, reviewer rejected" (with 95% range), "AI would have rejected, reviewer approved", and how often the AI couldn't decide.
  - **Detail:** agreement per service, AI vs reviewer time, and a list of disagreements linked to their locations. Small samples show "Not enough data".
- The location page says the AI result is withheld, or marks the assessment as shadow mode once visible.

### Verified
- **Tests:** 6 new integration tests covering shadow runs and no Fast Lane, no AI output in any endpoint for reviewers or for undecided leads (including filters, audit data and queue summary), no reason required, the AI view still recorded, leads comparing after the decision, and the results report. 456 tests in total.
- **Browser:**
  - **Reviewer:** sees only photos and required services, no AI wording, and rejects without a reason.
  - **Team lead:** sees the disagreement on Shadow results.

## [0.13.0] — Phase 13: Evaluation set and evaluation runner — 2026-10-06

### Added
- **Evaluation set ("golden examples", PRD §55):** examples with the correct answer per service, checked by a person.
  - **Creating:** from any decided location (**Add to evaluation set**: photos copied, truth prefilled from the decision, case types suggested), or by importing past cases with `npm run golden:import -- <folder>` (photos plus `manifest.json`, HEIC supported, all-or-nothing).
  - **Approving:** drafts need a second team lead (admins may self-approve, which is audited). Approved examples are frozen by a database trigger; corrections retire them and add a new one. Nothing is ever deleted.
  - **Demo examples:** 10 approved examples from the mock scenarios, with their intended truth, always labelled as demo data.
- **Evaluation runner (PRD §56):** runs the exact production pipeline (active rules, thresholds, client profiles, AI provider) against approved examples.
  - **Isolation:** it runs in a temporary in-memory database, so the live queue, locations, dashboard and NetSuite are untouched. It runs in the background, one at a time.
  - **Cost:** external AI runs require confirming the cost.
  - **Model trials:** admins can trial another model for a single run without changing production.
- **Report:**
  - **Rates:** false approval and false rejection rates, precision, recall, left to a person, and right when it decided, each with a 95% range.
  - **Report table:** samples, correct, incorrect, false approval, false rejection, left to a person, human override.
  - **Breakdowns:** by service, whole location, client, case type, photo quality and AI confidence (calibration).
  - **Context:** coverage gaps, the versions evaluated, a comparison with another run, and per-example results.
  - **Warnings:** demo data and small samples are called out on the report itself.
- Migration `0012`: `golden_examples`, `golden_example_images`, `evaluation_runs`, `evaluation_results` (append-only), immutability triggers, audit types.

### Safety
- Evaluation results never change production behaviour (PRD §57). Automating any decision still needs a representative real dataset, measured results, and explicit business approval (PRD §54); levels 4 and 5 stay disabled in code.
- The report never presents a bare "0%": with few examples, the 95% range shows how little that means.

### Verified
- **Tests:** 14 new: 7 unit tests for scoring and intervals, and 7 integration tests covering creation from a location, label rules, the database freeze, demo seeding, folder import (including path checks), a full sandboxed run with outcomes checked case by case, and a check that no live locations, NetSuite writes or outbox rows were created.
- **Browser** (light and dark):
  - A lead created a draft, and self-approval was refused.
  - An admin seeded demos and ran an evaluation.
  - The report showed 0 false approvals on 5 "should reject" cases with a 0–43% range, plus the demo-data and small-sample warnings and the coverage gaps.

## [0.12.0] — Phase 12: Team lead dashboard — 2026-10-06

### Added
- **Dashboard** (`/dashboard`, team leads and admins; PRD §4, §44, §79, §80).
  - **Hero and diagnosis:** opens with what is still open and how much of the workload is cleared. A plain-language answer to "why isn't today's queue clearing?" lists what blocks it, most important first:
    - a stalled worker
    - credential failures
    - AI provider outage
    - decisions stuck on the way to NetSuite
    - problems waiting in the Problems lane
    - reviewer backlog with the oldest wait
  - **Queue:** received, AI processed, decided, escalated, completed in NetSuite, waiting for a reviewer (with oldest wait), being analysed, problems, on the way to NetSuite.
  - **Time:** median review time per location, AI processing per location and per photo, reviewer time saved. Time saved needs `METRICS_BASELINE_REVIEW_SECONDS`; it is never guessed.
  - **AI and reviewers:**
    - agreement with the AI, decisions against the AI, and how often the AI left the call to a person
    - "approve" suggestions that reviewers rejected
    - photos analysed and quality failures, plus AI response time
    - agreement by AI confidence band, and the AI suggestion mix
  - **Effort:** photos per location, photos opened full size, decisions made without opening every photo.
  - **AI cost:** total, per location, per photo, per decided location, photo analysis vs before/after, cache reuse, and a per-client table.
  - **Reviewers table, plus system health:** NetSuite writes and latency, job backlog, last finished job, open problems by category.
  - **Filters:** Today / 7 days / 30 days or a custom range, client, service, risk, reviewer. Status, AI confidence and exception type appear as breakdowns. Today's view refreshes every minute.
- **Honesty rules:**
  - Any rate based on fewer than 30 cases (`thresholds.metrics.min_sample_size`) shows "Not enough data" with the count, never a percentage.
  - False approval and false rejection rates show "Not measured yet" until checked ground truth exists (Phases 13 and 15).
  - Agreement is labelled as agreement with reviewers, not accuracy.
- NetSuite write latency is now recorded on each successful write.
- `GET /api/dashboard`, `GET /api/dashboard/scopes`, and a metric definitions table in `docs/API.md`.

### Fixed
- On phone-width screens the top bar no longer pushes every page wider than the screen. The navigation scrolls inside its own row.

### Design
- Chart bars use a dedicated `--data` colour, validated for lightness, chroma and contrast against both light and dark surfaces. The UI's muted blue failed the chroma floor for chart marks.

### Verified
- **Tests:** 11 new tests covering the rate suppression rule, agreement and deferral counting, confidence-band agreement, diagnosis wording and order, and the dashboard over real decisions (queue counts, clearance, timing, suppression, NetSuite writes, filters, range validation, configurable minimum sample, unset baseline).
- **Browser:** checked in light and dark, desktop and 390 px phone width, with no sideways scrolling.

## [0.11.0] — Phase 11: NetSuite write-back — 2026-10-06

### Added
- **Decisions are written back to NetSuite** (PRD §37–39), against the mock adapter until the real NetSuite details (U1–U6) are known.
  - Every approve or reject sends the verification result: decision, reviewer, time, processing run, and per-service decisions.
  - When the reviewer gave a reason, a plain-text note is sent too. Escalations stay internal.
- **Transactional outbox:**
  - **One transaction:** the decision, its NetSuite writes and the sync job commit together, so a crash or outage can't lose a decision.
  - **Status path:** `APPROVED/REJECTED → SYNCING → SYNCED_TO_NETSUITE → COMPLETED`.
- **Safety:**
  - **No duplicates:** stable idempotency keys, and a retry after a crash is recognised as already applied.
  - **No overwrites:** the record is re-read before writing, and a decision made directly in NetSuite is never overwritten.
  - **Retries (PRD §78):** temporary failures retry with exponential backoff up to `NETSUITE_SYNC_MAX_ATTEMPTS` (8). Authentication, validation and configuration errors stop at once and send the location to the Problems lane (`NETSUITE_ERROR`).
- **Team lead recovery:** "Retry sending to NetSuite" on the location page (`POST /api/locations/:id/netsuite/retry`). Open problems close when the write succeeds.
- **Sweep:** decided locations without a sync, e.g. decisions made before this release, are queued automatically (`NETSUITE_SYNC_SWEEP_INTERVAL_SEC`).
- **Location page:**
  - **NetSuite section:** each write's state (waiting, sending, sent with NetSuite reference, will retry, stopped), attempts, and the plain reason when it stopped.
  - **History:** NetSuite and error events now have readable descriptions.
  - **Reprocess:** no longer offered while a decision is on its way to NetSuite (the server already refused it).
- Migration `0011`: outbox columns `last_attempt_at`, `remote_ref`, `already_applied`, and the audit type `NETSUITE_SYNC_RETRY_REQUESTED`.

### Verified
- **Tests:** 10 new integration tests covering atomic outbox and job, the success path and its status chain, the note on overrides, demo case 7 (three transient failures, retried, one write), a validation error stopping at once with team-lead retry, refusal to overwrite a decision made in NetSuite, crash between write and bookkeeping (no duplicate), no write on escalation, and the sweep. 425 tests in total.
- **Browser** (fresh database):
  - **Demo 004:** approved with a reason; verification and note sent; Completed.
  - **Demo 007:** shows "Failed — will retry" while NetSuite fails.

## [0.10.0] — Phase 10: Overrides, feedback and team knowledge — 2026-10-05

### Added
- **Feedback capture (PRD §29–30).** Every decision with a reason writes immutable `feedback` rows in the same transaction as the decision.
  - **One row per service the reviewer disagreed on.** It records the AI status and confidence, the recommendation, the human decision, the reason and note, the reviewer, the run and the time. A disagreement with the overall recommendation only, or a reason given while agreeing, gives one location-level row.
  - **Flagged photos.** Reviewers can flag up to 10 photos in the full-size viewer (button or `F`) as the "relevant image"; each flagged photo becomes its own row. Flagging opens the reason form even when agreeing; photos must belong to the location.
  - The override audit event now lists the flagged photos.
- **Feedback page (team leads).**
  - **Filters:** date range, reason, service, and "only decisions against the AI".
  - **Summary:** counts by reason, each one a click-to-filter link.
  - **CSV export:** each export is audited (`FEEDBACK_EXPORTED`), and cells are guarded against spreadsheet formula injection.
- **Team knowledge base (PRD §31).**
  - **Content:** searchable notes (reviewer notes, service definitions, client instructions, edge cases, weekly feedback, past examples), scoped to a client and/or service.
  - **Curation:** team leads add, revise and archive. Revising creates a new version and archives the old one, and a database trigger forbids changing or deleting note content. Additions and archives are audited.
  - **Review screen:** the "Notes from the team" panel shows only notes for the location's client (or all clients) and its services, labelled as guidance that doesn't change the client's current rules.
- **Import for historical notes:** `npm run knowledge:import -- notes.json` (all-or-nothing validation, safe to re-run). The format is in `docs/KNOWLEDGE_BASE.md`, with an example in `docs/examples/`.
- **Readable location history:** each event names the person behind it and gives a plain description (decision, AI suggestion, time spent, override reason). Decisions list their feedback rows.

### Safety
- Feedback and notes never change assessments: no pipeline stage reads them. Notes are not sent to the AI; that needs evaluation first (Phase 13).
- Migration `0010` adds columns to `feedback` (`location_id`, `reviewer_id`, `run_id`, `ai_recommendation`, `ai_confidence`, `is_override`), title, versioning and archive fields to `knowledge_notes`, the `knowledge_kind` enum, and three audit event types.

### Verified
- **Tests:** 22 new integration tests covering feedback rows, append-only enforcement, validation of flagged photos, team-lead-only access, CSV export and its audit, formula guarding, note versioning, the immutability trigger, client scoping and import. Plus a UI test for the flagging flow.
- **Browser walk-through, light and dark:**
  - **Reviewer:** sees team notes, flags a photo, decides with a reason.
  - **Team lead:** sees the feedback row, downloads the CSV, adds and revises notes.
  - **Reviewers** are redirected away from the Feedback page.

## [0.9.3] — Fix: dev server unreachable or refusing to start after a restart — 2026-10-05

### Fixed
- **Browser could not connect to `http://localhost:3000`** although the server was running: it listened on IPv4 (`127.0.0.1`) only, while the browser resolved `localhost` to IPv6 (`::1`). `HOST` now defaults to `localhost`, which listens on both.
- **"Database locked" after every unclean stop.** PGlite always writes its lock file with a placeholder PID, so it could not tell a crashed run from a live one; any force-kill (dev-watcher restart, closed terminal) blocked the next start. ALVIP now records the real owning process next to the data (`alvip-owner.json`): if that process is gone, the stale lock is removed automatically and normal crash recovery runs ("Recovered a stale database lock…"); if it is still running, startup stops with "in use by another ALVIP process (PID …)" instead of risking two writers.

### Verified
- Against the real local database: recovered a stale lock; served the UI at `localhost` and `127.0.0.1`; a second `npm run dev` was refused while the first stayed healthy; a force-killed server restarted cleanly. 392 tests passing (new tests for stale-lock recovery and live-owner refusal).

## [0.9.2] — Fix: local database kept inside OneDrive — 2026-10-05

### Fixed
- The embedded database could not be opened from inside the OneDrive folder after an unclean stop: recovery needs to write files that the sync client was locking. An identical copy outside OneDrive opened and recovered normally. Local data (database + image storage) now defaults to `%LOCALAPPDATA%\ALVIP\data` when the project is inside a cloud-synced folder (OneDrive, Dropbox, iCloud, Google Drive); otherwise `.data/` as before. The location is printed at startup.
- The startup message for this case wrongly blamed a leftover lock file; it now names the folder and the actual likely causes.

### Migration
- The existing local database was recovered from a copy and moved to `%LOCALAPPDATA%\ALVIP\data\pglite` (users and processed locations kept). The old `.data/` folder in the project was left untouched as a backup.

## [0.9.1] — Fix: server would not start on an older local database — 2026-10-05

### Fixed
- `npm run dev` crashed at startup (browser: `ERR_CONNECTION_REFUSED`) when the local database had last been seeded by an earlier version: the stored thresholds (v1) lacked settings added in v2–v6. Development now loads the current `config/` files into the database on startup (idempotent; changes become new, audited versions). Production does not auto-apply config; it now stops with a one-line instruction to run `npm run db:seed` instead of a validation dump.
- Config sync re-activates an existing version with identical content (e.g. after a rollback) instead of refusing it.
- Startup failures print one clear sentence for common causes (invalid/outdated config, port in use, locked local database) and the address once running.

### Verified
- Reproduced on a copy of the affected local database: crash before, starts and serves the UI after. 387 tests passing (new regression test for outdated stored config).

## [0.9.0] — Phase 9: Human review UI — 2026-10-05

### Added
- **Reviewer web app** (`apps/web`, React + Vite, served by the API in production):
  - **Queue**: lanes (Needs review, Fast lane, Problems, Search all) with counts; filters (search, risk) and order (oldest, highest risk, newest); "Start reviewing" opens the oldest location.
  - **Review workspace** (one location at a time, PRD §28): AI suggestion with "a suggestion only" note, named risk factors, each required service with verdict tag, plain explanation, reason phrases, component statuses and clickable evidence refs; tabs for strongest evidence (bundle), before/after and all photos (strongest first, with stage/duplicate/unusable markers).
  - **Before/after wipe comparison**: drag (or ←/→) to reveal the after-photo over the before-photo, with the model's same-area note and per-service changes alongside.
  - **Full-size viewer** with ←/→/Esc; full views are audited as evidence viewed.
  - **Decision bar**: Approve / Reject / Escalate / Skip with keyboard shortcuts (A/R/E/N). Agreeing with the AI is one action; going against the evidence opens a structured reason picker (note required for "Other"). After a decision the next location opens automatically.
  - **Fast lane** batch page (automation level 3): cards with service verdicts and strongest photos; approve selected.
  - **Location detail**: AI assessment, decisions (with "against AI" marker and reasons), processing runs (model, prompt version), full history; team leads can reprocess (with reason) and send exceptions to manual review.
  - Field-survey visual identity (spruce/sage/turf/ochre/brick/survey-blue, Bricolage Grotesque + IBM Plex, self-hosted fonts), light and dark mode, keyboard focus, reduced-motion respected.
- **Review API**: `POST /api/locations/:id/review` (immutable `human_reviews` record with AI snapshot, conflicts, reason, evidence viewed — client-reported plus server-audited full views — and open time; transition + `HUMAN_DECISION` / `HUMAN_OVERRIDE` audit in one transaction), `POST /api/locations/:id/review/open`, `GET /api/locations/:id/reviews`, `GET /api/review/next` (oldest first, optional lane), `POST /api/review/fast-lane/confirm` (level 3 only; Fast Lane approve recommendations only; one review record per location).
- **Override rules** (PRD §25, §29): a structured reason is required to approve while any service is not SUPPORTED, to reject a strongly supported service, or to go against an approve/reject recommendation. Escalated locations are decided by team leads only. Concurrent decisions → 409, never a double decision.
- API serves the built UI (`WEB_DIST_DIR`): SPA fallback for client routes, real 404s for missing assets and API routes, immutable caching for fingerprinted assets, `no-store` for HTML/API, Content-Security-Policy for pages.

### Fixed during the phase
- Static serving with `wildcard: false` only knew assets present at startup; a rebuilt UI was answered with HTML and the browser rejected it. Now looked up per request, and missing assets return 404.
- Keyboard shortcuts crashed when the key event target was not an element (found by a component test).
- Dark mode: filled buttons used white text on light fills (low contrast) — now dark text.

### Verified
- 386 tests passing (incl. review API, Fast Lane batch, UI serving, and jsdom component tests for the decision bar and wipe slider).
- Live, in a real browser (Playwright): login → queue → demo case 4 → open a photo → press A → reason picker → approve with reason → next location opens. Stored: override with reason and note, AI snapshot, evidence viewed, open time; audit trail REVIEW_OPENED → EVIDENCE_VIEWED → LOCATION_STATUS_CHANGED → HUMAN_DECISION → HUMAN_OVERRIDE. Screens checked in light and dark mode.

## [0.8.0] — Phase 8: Risk engine, recommendation and lanes — 2026-10-05

### Added
- **Risk engine** (`domain/risk.ts`, pure): 13 named factors (PRD §24): contradiction, unable to determine, not supported, insufficient evidence, client/service rule requiring review, failed analyses, missing before/after, weak counter-evidence, conflicting outcomes across services, low confidence, poor image quality, unusual/irrelevant scenes, duplicate-heavy evidence. Score = sum of present factor weights (capped) banded into LOW/MEDIUM/HIGH; contradiction and "unable to determine" force HIGH; not supported, insufficient evidence, client rules and failed analyses force at least MEDIUM. Each factor has a plain-language detail. All weights/floors/ratios are configurable and provisional; the score is internal only.
- **AI recommendation**: `RECOMMEND_APPROVE` only when every service is SUPPORTED with HIGH confidence, none is flagged for a human, risk is LOW and no rule requires review; `RECOMMEND_REJECT` when a service is not supported and nothing is contradictory or undetermined; otherwise `NEEDS_HUMAN_REVIEW` with the top reasons. Recommendations never change the workflow: approval is still only reachable from human review.
- **Lanes** (PRD §36, §53): Fast Lane only at automation level 3, for a low-risk approve recommendation, never in shadow mode, and still awaiting a human; Human Review otherwise; Exception Lane unchanged.
- Risk stage persists `risk_assessments` (level, internal score, factors, recommendation, lane) and the run's recommendation/lane; `locations.risk_level` / `ai_recommendation` for queue filters (cleared on reprocess); `RISK_CALCULATED` audit event.
- APIs: location list filters `risk`, `recommendation`, sort `risk` (highest first, then oldest); queue summary `awaitingReviewByRisk`; evidence endpoint returns `recommendation` and `risk` (level + named factors, no score).
- Thresholds **v6** (provisional): `risk.weights`, `risk.floors`, `risk.*_ratio`.
- Migration `0009`.

### Changed during the phase
- The first approve rule allowed a recommendation when a service was supported only at MEDIUM confidence (risk was still LOW). Tightened: any service flagged for a human blocks `RECOMMEND_APPROVE`.

### Outcomes on mock scenarios (automation level 1)
- Demo 2 LOW / recommend approve; demo 1 and 7 LOW / needs review (one service at medium confidence); demo 4 HIGH (contradiction); demo 5 HIGH (poor images, no before/after); demo 6 MEDIUM (duplicate-heavy); demo 9 HIGH (before/after mismatch); demo 11 HIGH (client C rules, fertilization). At level 3 only demo 2 enters the Fast Lane; none in shadow mode.

### Verified
- 361 tests passing.

## [0.7.0] — Phase 7: Evidence bundling — 2026-10-05

### Added
- **Evidence bundler** (`domain/bundle.ts`, pure): the smallest useful set of images per location, strongest first, each image listed once with every service and role it serves (`SUPPORTING`, `CONTRADICTING`, `CONTEXT`, `BEFORE`, `AFTER`).
  - **Always included**: both sides of every contradiction; significant counter-evidence; the before/after pair that established each service. The size cap (`bundle.max_images`, 16) only trims optional images.
  - **Strongest support**: top `bundle.per_service_supporting` (3) per service, one per duplicate cluster, spread across areas before taking a second photo of the same area. Baseline (before-photo) items and unusable images never count as support.
  - **No support**: one context image so the reviewer sees why (e.g. equipment only).
- **Evidence order for all images** (PRD §23): bundle first, then by evidence value (quality, strength, before/after role, counter-evidence); duplicates after their representative, unusable last. Order only, never shown as a number.
- Bundle stage in `EVIDENCE_BUILDING`: `evidence_bundle_items` table, `image_analysis.evidence_rank`, `evidence.in_bundle/rank`, `EVIDENCE_BUNDLED` audit event (sizes per service).
- APIs: evidence endpoint returns `bundle` (entries with rank, reasons, services) and each service's bundled images; image list supports `?order=evidence` and returns `inBundle` + summary count.
- Thresholds **v5** (provisional): `bundle.max_images`, `bundle.per_service_supporting`.
- Migration `0008`.

### Outcomes on mock scenarios
- 170-image location → 4 images; demo 6 (26 photos, 25 near-duplicates) → 2; demo 4 → 4 of 5 with the contradicting photo first; demo 1 → all 8 (small location, every photo is evidence).

### Verified
- 338 tests passing.

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
