# API

REST/JSON. Auth is a session cookie (`alvip_session`, httpOnly, SameSite=Strict) set by `POST /api/auth/login`.
Errors return `{ "error": "<CODE>" }`. 5xx responses never include internals.

Roles are hierarchical: `REVIEWER` < `TEAM_LEAD` < `ADMIN`.

## Implemented (Phase 1)

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/health` | public | `{status:"ok"}` or 503 `{status:"degraded"}` |
| POST | `/api/auth/login` | public | body `{email, password}` → `{user}` + cookie. 401 `INVALID_CREDENTIALS`, 429 `THROTTLED` |
| POST | `/api/auth/logout` | any | revokes the session |
| GET | `/api/auth/me` | any | `{user}` |
| GET | `/api/services` | REVIEWER | active service registry |
| GET | `/api/clients` | REVIEWER | clients + active profile version; full `profile` for TEAM_LEAD+ |
| GET | `/api/config/thresholds` | TEAM_LEAD | active thresholds (includes `provisional`) |
| GET | `/api/config/runtime` | TEAM_LEAD | automation level, shadow mode, mock flags, app version |
| GET | `/api/admin/users` | ADMIN | list users |
| POST | `/api/admin/users` | ADMIN | body `{email, displayName, role, password(≥12)}` → 201; 409 `EMAIL_EXISTS` |

## Planned (PRD §76)

| Method | Path | Phase |
|---|---|---|
| POST | `/api/jobs/location/:id` | 2 |
| GET | `/api/jobs/:id` | 2 |
| GET | `/api/locations` (search/filter: id, client, service, status, date, result, processing ID) | 2 / 9 |
| GET | `/api/locations/:id` | 2 |
| GET | `/api/locations/:id/images` | 3 |
| GET | `/api/locations/:id/evidence` | 7 |
| POST | `/api/locations/:id/review` | 9 |
| POST | `/api/locations/:id/reprocess` | 2 |
| GET | `/api/dashboard`, `/api/analytics` | 12 |
