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
| HEIC photos slow to process | HEVC HEIC is decoded in WebAssembly (~0.3 s per 1.4 MP image; a 12 MP iPhone photo takes longer), max 2 at a time | Expected; tune `IMAGE_FETCH_CONCURRENCY`/worker count. `image_analysis.quality_metrics.decoder` shows `libheif` for these images |
| HEIC tests skipped | The real HEIC sample is not committed | `npx tsx apps/server/src/scripts/fetchHeicFixture.ts`, or drop a real crew HEIC at `fixtures/heic/sample.heic` |
| `... sends client images to a third-party API` on start | `MOCK_AI=false` without `ALLOW_EXTERNAL_AI_IMAGE_PROCESSING=true` | Set it only after data-processing approval, or keep `MOCK_AI=true` |
| `VISION_PROVIDER=openai has no default model` | OpenAI selected without `VISION_MODEL` | Set `VISION_MODEL` to the evaluated OpenAI vision model |
| `Prompt image_analysis_v1 was modified after it was first used` | A prompt file was edited in place | Revert it and create `image_analysis_v2.md`; prompts are immutable once used |
| Location stuck retrying then `AI_ERROR` | Provider outage / rate limit, or every response malformed or refused | See the run's `AI_VISION_COMPLETED` audit event and `image_analysis.validation_error`. The location can be sent to manual review from the Exception Lane |
| Images show `MALFORMED` | The model returned invalid output twice | Check `image_analysis.raw_response`; frequent occurrences mean the prompt/schema needs a new version |
| Reset local DB | — | Stop the API, delete `.data/pglite` and `.data/images`, re-run `npm run db:seed` |

"Why is today's queue not clearing?": once Phase 12 lands, the dashboard and the Exception Lane answer this. Until then, check the `system_errors` and `verification_jobs` tables.
