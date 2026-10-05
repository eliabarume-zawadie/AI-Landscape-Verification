# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ConfigError: AUTOMATION_LEVEL=4 is not permitted` | Levels 4–5 are disabled in this release | Use 0–3 |
| `ConfigError: Mock providers are not allowed in production` | `NODE_ENV=production` with a `MOCK_*=true` | Set mocks false and configure real providers |
| `No active service rules / thresholds in database` | DB not seeded | `npm run db:seed` |
| `Service rules version "…" already exists with different content` | A config file was edited without bumping `version` | Bump `version` in the JSON file, re-run seed |
| `table audit_events is append-only` | Something tried to modify audit history | Expected; audit rows cannot be changed. Fix the caller |
| Login always 429 | Throttle after 5 failures in 15 min for that email + IP | Wait, or restart the API (in-memory throttle) |
| Cookie not set over http://localhost | `COOKIE_SECURE=true` | Set `COOKIE_SECURE=false` locally |
| `EPERM` / file locks during `npm install` | OneDrive syncing `node_modules` | Exclude `node_modules/` and `.data/` from OneDrive or move the repo |
| `PGlite failed to initialize properly` on start | The previous dev server was force-killed and left `.data/pglite/postmaster.pid` | Make sure no API process is running, delete `.data/pglite/postmaster.pid`, start again. Stop the dev server with Ctrl+C, not a force-kill |
| A location stays `QUEUED` for a while | A transient failure is in backoff (30 s base, doubling, 30 min cap) | Check `GET /api/jobs/:id` / `verification_jobs.last_error` |
| Location in `INTEGRATION_ERROR` right after ingest | Unknown client, unknown service code, or no services | See the location's `openErrors`; fix config (`config/`), then reprocess |
| Standalone worker refuses to start | It needs PostgreSQL (`DATABASE_URL`) | With PGlite use `WORKER_MODE=embedded` (default) |
| Image returns 410 | Purged under the retention policy | Expected; analysis and hashes remain. Re-fetch by reprocessing if the source still has it |
| Many real photos flagged `CORRUPT` | Possibly HEIC (HEVC) from iPhones, which sharp's prebuilt binaries most likely cannot decode (untested) | Confirm source formats (plan A15); convert upstream or add a HEIC-capable decoder |
| Reset local DB | — | Stop the API, delete `.data/pglite` and `.data/images`, re-run `npm run db:seed` |

"Why is today's queue not clearing?": once Phase 12 lands, the dashboard and the Exception Lane answer this. Until then, check the `system_errors` and `verification_jobs` tables.
