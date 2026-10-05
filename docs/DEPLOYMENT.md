# Deployment

**Status:** Dockerfile and docker-compose are provided but **untested** (Docker is not installed on the development machine). Hosting target is unknown (U13).

## Shape

- One container image, two roles: `api` (`npm start -w @alvip/server`, with `WORKER_MODE=off` when separate workers run) and `worker` (`npm run worker -w @alvip/server`). Scale workers horizontally; they coordinate through Postgres row locks and leases.
- PostgreSQL 16 (managed in production).
- TLS terminated upstream; `COOKIE_SECURE=true` (enforced).
- Migrations run on API start; for multi-instance deploys run `npm run db:migrate` as a release step.

## Required production environment

`NODE_ENV=production`, `DATABASE_URL`, `MOCK_NETSUITE=false`, `MOCK_AI=false`, `MOCK_IMAGES=false`, `AUTOMATION_LEVEL` (0–3), plus NetSuite credentials once available. For AI: `VISION_PROVIDER=anthropic`, `ALLOW_EXTERNAL_AI_IMAGE_PROCESSING=true` (only after data-processing approval), and Anthropic credentials (`ANTHROPIC_API_KEY` or a workload-identity setup). Startup fails if any of these safety settings are wrong.

## Local production-like stack

```bash
docker compose up --build
docker compose exec api npm run db:seed
```

## Rollout (PRD §90)

Historical analysis → shadow mode → AI assist → evidence bundling standard → fast track (still human-confirmed). Level 4+ is out of scope for this release.
