# ALVIP — AI Landscape Verification Intelligence Platform

AI-assisted verification of landscape-service photos for locations queued in Oracle NetSuite.
The AI organises the evidence and flags risk. **People make every final decision**: fully automatic approval does not exist in this release.

- Product spec: [PRD.md](PRD.md)
- Build plan, assumptions, open questions: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- What changed, phase by phase: [CHANGELOG.md](CHANGELOG.md)
- Technical docs: [docs/](docs/)

## Status

All planned phases (0–15) are built and tested **against mock integrations**: a simulated NetSuite queue, generated demo photos, and a scripted AI. The production NetSuite connection is the remaining piece. It is blocked on access details from the NetSuite administrator (U1–U6 in the plan; see [docs/NETSUITE_INTEGRATION.md](docs/NETSUITE_INTEGRATION.md)). The real Anthropic (default) and OpenAI vision connectors are implemented; they are switched off until external image processing is approved.

| Area | What it does |
|---|---|
| Queue & processing | Pulls the verification queue, fetches photos (incl. iPhone HEIC), checks quality, finds duplicates, runs the AI, retries failures, puts problems in an Exception Lane |
| Evidence | Per-service verdicts (supported / not supported / not enough evidence / contradictory / couldn't assess), before/after pairs, strongest photos first, risk level and a suggestion |
| Review | One location at a time, before/after slider, full-size viewer, keyboard shortcuts, a reason required when going against the AI, Fast Lane batch confirmation |
| NetSuite write-back | Decisions and notes sent through a crash-safe outbox with retries; never overwrites a decision made in NetSuite |
| Learning loop | Feedback on overrides, team knowledge notes, evaluation set (checked examples) and sandboxed evaluation runs |
| Safe rollout | Shadow mode (AI hidden), per-client rollout modes, quality-control sampling of approvals |
| Oversight | Team-lead dashboard ("why isn't the queue clearing?"), full audit history, cost tracking |

## Requirements

- Node.js 22+
- No database install for local use: an embedded PostgreSQL (PGlite) is used when `DATABASE_URL` is empty.

## Quick start (mock mode)

Windows (Command Prompt):

```cmd
npm install
copy .env.example .env
npm run db:seed
npm run build:web
npm run dev
```

macOS / Linux: the same, with `cp .env.example .env`.

- `npm run db:seed` loads the configuration and creates demo users; their passwords are printed **once**.
- `npm run dev` starts the API, the UI and the background worker. The mock queue is pulled every minute.
- Open **http://localhost:3000** and sign in. Stop the server with **Ctrl+C**, not by killing the process (the local database can be damaged by a hard kill).

Create your own user (stop `npm run dev` first; the local database allows one program at a time):

```cmd
set ALVIP_NEW_PASSWORD=at-least-12-characters
npm run user:create -- you@company.com ADMIN "Your Name"
set ALVIP_NEW_PASSWORD=
```

Roles: `REVIEWER` (review and decide), `TEAM_LEAD` (plus escalations, dashboard, feedback, knowledge, evaluation, quality checks), `ADMIN` (plus rollout settings, demo data, model trials).

## Using it

| Who | Where | What |
|---|---|---|
| Reviewer | **Queue → Start reviewing** | Work oldest-first; `A` approve, `R` reject, `E` escalate, `N` next, `F` flag a photo in the viewer |
| Reviewer | **Fast lane** | Confirm strong, low-risk approvals in a batch (when enabled) |
| Team lead | **Dashboard** | Today's queue, why it isn't clearing, AI agreement, cost, system health |
| Team lead | **Queue → Problems** | Photo, AI, data and NetSuite problems; send to manual review or retry |
| Team lead | **Feedback**, **Team knowledge** | Where reviewers disagreed with the AI; guidance notes for reviewers |
| Team lead | **Evaluation**, **Shadow results** | Measure the AI against checked examples and against live decisions |
| Team lead / admin | **Rollout** | Per-client AI use (manual, shadow, assist, fast track) and quality checks of approvals |

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | API + UI + worker on http://localhost:3000 |
| `npm run build:web` | Build the UI (needed once, and after UI changes) |
| `npm run web` | UI with hot reload on http://localhost:5173 (run alongside `npm run dev`) |
| `npm test` | All tests (unit, integration, UI) |
| `npm run typecheck` | TypeScript checks |
| `npm run db:seed` | Migrate, load `config/` as versioned rows, create demo users |
| `npm run db:migrate` / `db:generate` | Apply migrations / generate one after a schema change |
| `npm run user:create -- <email> <ROLE> "<name>"` | Create a user (password from `ALVIP_NEW_PASSWORD`) |
| `npm run knowledge:import -- <notes.json>` | Import reviewer notes ([docs/KNOWLEDGE_BASE.md](docs/KNOWLEDGE_BASE.md)) |
| `npm run golden:import -- <folder>` | Import labelled historical cases ([docs/AI_EVALUATION.md](docs/AI_EVALUATION.md)) |

## Repository layout

```text
apps/server/     API, worker and pipeline — Fastify, Drizzle, Zod
apps/web/        Reviewer and team-lead UI — React, Vite
packages/shared/ Enums and config schemas shared by both
config/          Versioned service rules, thresholds (provisional), client profiles (demo)
prompts/         Versioned AI prompts
docs/            Architecture, API, database, security, AI, NetSuite, rollout, deployment, troubleshooting
```

## Configuration you should know about

- **Service rules:** `config/services.json`. Thresholds: `config/thresholds.json` (provisional until set from evaluation data). Client profiles: `config/client-profiles/*.json` (demo data). In development, edits are picked up on restart as new, audited versions.
- **AI provider:** `VISION_PROVIDER=anthropic` (default) or `openai`; `MOCK_AI=false` and `ALLOW_EXTERNAL_AI_IMAGE_PROCESSING=true` to use a real one.
- **Automation ceiling:** `AUTOMATION_LEVEL` 0–3 (4–5 refused). Per-client modes are set on the **Rollout** page ([docs/ROLLOUT.md](docs/ROLLOUT.md)). `SHADOW_MODE=true` forces shadow mode everywhere.
- **Dashboard:** `METRICS_TIMEZONE` defines "today"; `METRICS_BASELINE_REVIEW_SECONDS` (time per location before ALVIP) enables "time saved".

> **OneDrive note:** when the project is inside a synced folder (OneDrive, Dropbox…), the local database and photos are stored in `%LOCALAPPDATA%\ALVIP\data` instead of `.data/`, because sync clients lock database files. The location is printed at startup.

Problems? See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
