# ALVIP — AI Landscape Verification Intelligence Platform

AI-assisted verification of landscape-service photos for locations queued in Oracle NetSuite.
AI organises evidence and flags risk; **humans make every final decision** in this release.

- Product spec: [PRD.md](PRD.md)
- Build plan, assumptions, unknowns: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- Changes by phase: [CHANGELOG.md](CHANGELOG.md)
- Technical docs: [docs/](docs/)

## Status

Phases 1–3 are complete: foundation (config, schema, auth/RBAC, audit, versioned rules), queue processing (Postgres job queue, mock NetSuite ingest, location processor, reprocessing, Exception Lane), image ingestion (private storage, pixel quality checks, exact/near-duplicate clustering, retention, iPhone HEIC), and AI vision observations (versioned prompt, strict validation, caching, mock + Claude providers). Evidence/risk engines, the review UI, and NetSuite sync come in later phases. See the phase table in the implementation plan.

## Requirements

- Node.js 22+
- No database install needed for local development: embedded PostgreSQL (PGlite) is used when `DATABASE_URL` is empty.

## Quick start (mock mode)

```bash
npm install
cp .env.example .env          # defaults: mocks on, automation level 1
npm run db:seed               # migrate, load config/, create dev users (passwords printed once)
npm run build:web             # build the reviewer UI once
npm run dev                   # API + UI on http://127.0.0.1:3000 (worker runs inside; mock queue is pulled every minute)
```

Open http://127.0.0.1:3000 and sign in with a dev user. For UI development with hot reload, run `npm run dev` and `npm run web` together and open http://127.0.0.1:5173 (it proxies `/api`).

Check the API is up: `curl http://127.0.0.1:3000/api/health`

To create a user later:

```bash
ALVIP_NEW_PASSWORD='at-least-12-chars' npm run user:create -- someone@example.com REVIEWER "Some One"
```

## Scripts

| Command | Purpose |
|---|---|
| `npm test` | All unit, integration and UI component tests (in-memory PGlite, jsdom) |
| `npm run build:web` | Build the reviewer UI into `apps/web/dist` (served by the API) |
| `npm run web` | UI dev server with hot reload (proxies `/api` to the API) |
| `npm run typecheck` | TypeScript checks |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Migrate + sync `config/` into versioned DB rows + dev users |
| `npm run db:generate` | Generate a migration after editing `apps/server/src/db/schema.ts` |

## Repository layout

```text
apps/server/     API + workers — Fastify, Drizzle, Zod
apps/web/        Reviewer UI — React, Vite
packages/shared/ enums and config schemas shared with the web app
config/          versioned service rules, thresholds (provisional), client profiles
prompts/         versioned AI prompt templates (Phase 4)
docs/            architecture, API, database, security, deployment…
```

## Configuration you should know about

- **Service rules** — `config/services.json`. Edit → bump `version` → `npm run db:seed`. Old versions are kept.
- **Thresholds** — `config/thresholds.json`. All values are **provisional** until set from evaluation data.
- **Client profiles** — `config/client-profiles/*.json`. Current files are demo data only.
- **Automation level** — `AUTOMATION_LEVEL` 0–3. Levels 4–5 are refused at startup.

> **OneDrive note:** when the project is inside a synced folder (OneDrive, Dropbox…), the local database and images are stored in `%LOCALAPPDATA%\ALVIP\data` instead of `.data/`, because sync clients lock database files. The location is printed at startup. Consider excluding `node_modules/` from sync as well.
