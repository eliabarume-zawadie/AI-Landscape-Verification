# Security

## Implemented (Phase 1)

| Control | Implementation |
|---|---|
| Password storage | argon2id (`@node-rs/argon2` defaults), min 12 chars |
| Sessions | 256-bit random token in an httpOnly, SameSite=Strict, Secure (prod) cookie; only the SHA-256 is stored; server-side revocation on logout; expiry `SESSION_TTL_HOURS` |
| Brute force | Per (email, IP) throttle: 5 failures / 15 min (single instance; move to shared store when scaling out) |
| Account enumeration | Same response and similar timing for unknown user vs wrong password |
| Authorization | Role hierarchy enforced per route (`requireRole`) |
| CSRF | SameSite=Strict cookies + JSON-only bodies |
| Headers | `nosniff`, `X-Frame-Options: DENY`, `no-referrer`, `Cache-Control: no-store`, HSTS in production |
| Log hygiene | Cookie/authorization headers redacted from request logs |
| Secrets | Env vars only; `.env` git-ignored; `.env.example` has no values; no dev passwords in source (seed generates random ones) |
| Production guards | Startup refuses mocks, PGlite, or insecure cookies when `NODE_ENV=production` |
| Audit | Logins, failed logins, logouts, user creation, config changes → append-only `audit_events` |
| Unsafe automation | `AUTOMATION_LEVEL` > 3 refused at startup |

## Planned

- Images served only through authenticated API endpoints / short-lived signed URLs; never public (Phase 3).
- Image retention purge (Phase 3).
- Access logging of evidence views (`EVIDENCE_VIEWED`, Phase 9).
- SSO via the organisation's IdP (unknown U12).
- Encryption at rest: managed Postgres + object-storage encryption (hosting decision U13).
- Third-party AI data handling: no client images are sent to an external AI provider until a DPA/privacy approval exists (unknown U9).

## Dependency notes

`drizzle-kit` (dev-only) depends on an esbuild version with a moderate advisory affecting esbuild's dev server. It is not part of the runtime and is not exposed. Re-check on drizzle-kit upgrades.

## HTTPS

TLS terminates at the load balancer / platform. The app sets `trustProxy` in production so client IPs in audit logs are correct.
