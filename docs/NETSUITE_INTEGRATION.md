# NetSuite Integration

**Status:**
- Interface defined (Phase 1).
- Mock adapter implemented (Phase 2, `integrations/netsuite/mock/`).
- Write-back pipeline implemented and tested against the mock (Phase 11).
- The production adapter is **blocked on the information below**. No NetSuite record types, field IDs, or endpoints have been assumed.

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

## Write-back (Phase 11)

Implemented in [`services/netsuiteSync.ts`](../apps/server/src/services/netsuiteSync.ts).

### What is written

| Write | When | Content |
|---|---|---|
| `updateVerification` | Every APPROVE / REJECT | Decision, reviewer name, decision time, processing run ID, per-service decisions (the location decision unless the reviewer split them) |
| `addVerificationNote` | Only when the reviewer gave a reason or note | Plain text, e.g. `ALVIP verification: Approved by Riley Reviewer on 2026-10-05 15:17 UTC. The reviewer decided against the AI assessment. Reason: AI missed evidence. Note: … Processing run 2.` |

Escalations are internal and are not written. AI scores and evidence are not written; NetSuite gets the human decision.

### Lifecycle

```
APPROVED / REJECTED ──► SYNCING ──► SYNCED_TO_NETSUITE ──► COMPLETED
                           │  ▲
                           ▼  │ team lead "Retry sending to NetSuite"
                      NETSUITE_ERROR   (Exception Lane)
```

### Safety (PRD §39)

| Guarantee | How |
|---|---|
| A decision can't be lost | The human decision, its `netsuite_sync_outbox` rows and the `NETSUITE_SYNC` job are committed in **one transaction**. A crash or NetSuite outage at any point leaves the write queued. |
| No duplicates | Each write has a stable idempotency key (`netsuite:verification:<reviewId>`, `netsuite:note:<reviewId>`). The adapter must treat a repeated key as already applied. A retry after a crash between "NetSuite accepted" and "ALVIP recorded it" is detected (`alreadyApplied`), not duplicated. |
| Never overwrite NetSuite | Before writing, the job re-reads the record. If NetSuite shows a decision that ALVIP did not write (someone changed it in NetSuite), the write stops with `NETSUITE_VALIDATION` and the location goes to the Exception Lane. |
| Retry policy (PRD §78) | `TRANSIENT` → exponential backoff with jitter (30 s doubling, capped at 30 min), up to `NETSUITE_SYNC_MAX_ATTEMPTS` (default 8). `AUTHENTICATION`, `NETSUITE_VALIDATION`, `CONFIGURATION` → stop at once (no endless retries), `NETSUITE_ERROR`, open problem recorded. |
| Recovery | A team lead fixes the cause, then uses **Retry sending to NetSuite** (`POST /api/locations/:id/netsuite/retry`). Resolved problems close automatically when the write succeeds. |
| Nothing left behind | A sweep (`NETSUITE_SYNC_SWEEP_INTERVAL_SEC`, default 60 s) queues any APPROVED/REJECTED location that has no sync yet, e.g. decisions made before Phase 11. |
| Audit | `NETSUITE_SYNC_ATTEMPTED` / `_SUCCEEDED` / `_FAILED` / `_RETRY_REQUESTED`, plus every status change. |

### Adapter contract for the production implementation

- `getLocation().existingVerificationStatus` must return the decision currently in NetSuite **in ALVIP terms** (`"APPROVE"` / `"REJECT"`), or `null`.
- `updateVerification` / `addVerificationNote` must be idempotent on `idempotencyKey`, for example by storing the key in a custom field and checking it before writing.
- Throw `IntegrationError` with the right category. Timeouts, 429 and 5xx are `TRANSIENT`; 401 and 403 are `AUTHENTICATION`; field and validation errors are `NETSUITE_VALIDATION`.

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
