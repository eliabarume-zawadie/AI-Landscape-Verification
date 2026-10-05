# NetSuite Integration

**Status:** interface defined (Phase 1). Mock adapter in Phase 2. The production adapter is **blocked on the information below**. No NetSuite record types, field IDs, or endpoints have been assumed.

## Interface

[`NetSuiteAdapter`](../apps/server/src/integrations/netsuite/NetSuiteAdapter.ts):

| Method | Purpose |
|---|---|
| `getQueue()` | Work items awaiting verification |
| `getLocation(externalId)` | Location visit details, client, existing status |
| `getRequiredServices(externalId)` | Service codes (mapped to ALVIP codes by the adapter) |
| `getImages(externalId)` | Image references + locator for the `ImageProvider` |
| `updateVerification(externalId, result)` | Write decision; idempotent by key |
| `addVerificationNote(externalId, note)` | Write note; idempotent by key |

Errors are raised as `IntegrationError` with a PRD §78 category (`TRANSIENT`, `AUTHENTICATION`, `NETSUITE_VALIDATION`, `CONFIGURATION`).

## Write safety (Phase 11)

- Human decision and `netsuite_sync_outbox` row are committed in one transaction, so a NetSuite outage cannot lose a decision.
- Outbox worker: exponential backoff for `TRANSIENT`; stop and alert for `AUTHENTICATION`; Exception Lane and admin action for `NETSUITE_VALIDATION`.
- Idempotency key per write; re-read the record before writing to detect decisions made elsewhere.

## Information needed from the NetSuite administrator

| # | Question |
|---|---|
| U1 | Account ID; is a sandbox available? Auth method: Token-Based Auth (OAuth 1.0a) or OAuth 2.0 client credentials? Integration record + role with least-privilege permissions. |
| U2 | Which record type represents a location visit awaiting verification (standard or custom record)? Is there a saved search / SuiteQL query that defines "the queue"? |
| U3 | Field IDs for: client, required services, image references, verification status, reviewer, notes, service date. |
| U4 | Where are images stored (File Cabinet, external URLs, another app)? How are they authenticated? Typical file sizes/formats? |
| U5 | Allowed values for the verification status field and what each triggers downstream. Is the decision per location or per service? |
| U6 | Concurrency / governance limits for the integration role. |

## Configuration

Credentials via environment only (see `.env.example`). Field mappings will live in a config file (not code); the production adapter will refuse to start if any required mapping is missing.
