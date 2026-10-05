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
| Image access | Bytes only via authenticated `/content` endpoint, scoped to the image's location; `Cache-Control: private, no-store`; full views audited; no public URLs; locators/storage keys never returned by the API |
| Image storage | Private directory (`STORAGE_DIR`), atomic writes, storage keys validated against path traversal |
| Malicious images | Decode guarded by `max_input_pixels` (decompression bombs) and `max_image_bytes`; undecodable files are recorded as `CORRUPT`, never served transcoded |
| Retention | Image bytes purged after `IMAGE_RETENTION_DAYS` for finished locations (`IMAGES_PURGED` audit) |
| External AI | No image leaves the system unless `ALLOW_EXTERNAL_AI_IMAGE_PROCESSING=true` is set explicitly (startup refuses otherwise); runs and audit events record `externalProvider` |
| AI output | Treated as untrusted input: schema- and registry-validated, size-limited, never executed, never able to set a status or decision |
| Unsafe automation | `AUTOMATION_LEVEL` > 3 refused at startup |

## Planned

- Access logging of evidence views (`EVIDENCE_VIEWED`, Phase 9).
- SSO via the organisation's IdP (unknown U12).
- Encryption at rest: managed Postgres + object-storage encryption (hosting decision U13).
- Third-party AI data handling: enforced by `ALLOW_EXTERNAL_AI_IMAGE_PROCESSING` (default false); set it only once a DPA/privacy approval exists (unknown U9).

## Dependency notes

`drizzle-kit` (dev-only) depends on an esbuild version with a moderate advisory affecting esbuild's dev server. It is not part of the runtime and is not exposed. Re-check on drizzle-kit upgrades.

## HEIC decoding

iPhone HEIC photos are decoded with `heic-decode` (ISC), which wraps `libheif-js` (**LGPL-3.0**, libheif + libde265 compiled to WebAssembly). It's used unmodified as a runtime dependency. Points for the business/legal to confirm before production:
- LGPL-3.0 obligations for distributing the application (normally satisfied for unmodified, separately loaded libraries, but confirm with legal).
- HEVC is a patent-encumbered codec; decoding in software may have licensing implications depending on jurisdiction and distribution model.

The decoder runs on untrusted input inside WebAssembly. The pixel limit is checked from the HEIF header before decoding.

## HTTPS

TLS terminates at the load balancer / platform. The app sets `trustProxy` in production so client IPs in audit logs are correct.
