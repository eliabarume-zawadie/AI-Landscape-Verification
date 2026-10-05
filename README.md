# ALVIP — AI Landscape Verification Intelligence Platform

AI-assisted verification of landscape-service photos for locations queued in Oracle NetSuite.
AI organises evidence and flags risk; **humans make every final decision** in this release.

- Product spec: [PRD.md](PRD.md)
- Build plan, assumptions, unknowns: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- Changes by phase: [CHANGELOG.md](CHANGELOG.md)
- Technical docs: [docs/](docs/)

## Status

Phase 1 (foundation) is complete: configuration, database schema, authentication/RBAC, audit log, versioned service rules and client profiles, adapter interfaces. The processing pipeline, review UI and NetSuite sync come in later phases. See the phase table in the implementation plan.

## Requirements

- Node.js 22+
- No database install needed for local development: embedded PostgreSQL (PGlite) is used when `DATABASE_URL` is empty.

## Quick start (mock mode)

```bash
npm install
cp .env.example .env          # defaults: mocks on, automation level 1
npm run db:seed               # migrate, load config/, create dev users (passwords printed once)
npm run dev                   # API on http://127.0.0.1:3000
```

Check it's up: `curl http://127.0.0.1:3000/api/health`

To create a user later:

```bash
ALVIP_NEW_PASSWORD='at-least-12-chars' npm run user:create -- someone@example.com REVIEWER "Some One"
```

## Scripts

| Command | Purpose |
|---|---|
| `npm test` | All unit + integration tests (uses in-memory PGlite) |
| `npm run typecheck` | TypeScript checks |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Migrate + sync `config/` into versioned DB rows + dev users |
| `npm run db:generate` | Generate a migration after editing `apps/server/src/db/schema.ts` |

## Repository layout

```text
apps/server/     API + (later) workers — Fastify, Drizzle, Zod
packages/shared/ enums and config schemas shared with the web app
config/          versioned service rules, thresholds (provisional), client profiles
prompts/         versioned AI prompt templates (Phase 4)
docs/            architecture, API, database, security, deployment…
```

## Configuration you should know about

- **Service rules** — `config/services.v1.json`. Edit → bump `version` → `npm run db:seed`. Old versions are kept.
- **Thresholds** — `config/thresholds.v1.json`. All values are **provisional** until set from evaluation data.
- **Client profiles** — `config/client-profiles/*.json`. Current files are demo data only.
- **Automation level** — `AUTOMATION_LEVEL` 0–3. Levels 4–5 are refused at startup.

> **OneDrive note:** this folder is synced by OneDrive. Exclude `node_modules/` and `.data/` from sync (or move the repo) to avoid file-lock errors.
