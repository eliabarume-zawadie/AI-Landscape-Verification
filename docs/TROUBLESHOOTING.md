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
| Reset local DB | — | Stop the API, delete `.data/pglite`, re-run `npm run db:seed` |

"Why is today's queue not clearing?": once Phase 12 lands, the dashboard and the Exception Lane answer this. Until then, check the `system_errors` and `verification_jobs` tables.
