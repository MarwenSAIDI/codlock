# CODLOCK Backend — Hardening & Completion Plan

Scope: harden and complete the **existing** implementation. No rebuild, no
architecture change, no stack migration. Every item below is mapped to the
files that actually need to change.

Status legend: **DONE** · **PARTIAL** · **TODO** · **BLOCKED (needs operator)**

---

## P0 — Blocking · *complete*

| # | Task | Files | Status |
| --- | --- | --- | --- |
| 1 | Verify the schema against a real PostgreSQL engine | `test/utils/pg-harness.ts`, `test/db.integration-spec.ts` | **DONE** |
| 2 | Execute `schema.sql` + both migrations on a real database | same | **DONE** locally · **BLOCKED** on Supabase |
| 3 | Real database integration tests | `test/db.integration-spec.ts`, `test/jest-db.json` | **DONE** — 54 tests |
| 4 | Verify all stored PostgreSQL functions | `test/db.integration-spec.ts` | **DONE** — all 3 |
| 5 | Real write-path smoke tests | `test/db.integration-spec.ts`, `scripts/verify-db.ts` | **DONE** at SQL level · **BLOCKED** end-to-end |

**Why two items are still BLOCKED:** `.env` carries only a PostgREST
service-role key. That key cannot execute DDL, and there is no database
password, connection string, or Management API token anywhere in the repo. The
schema must be applied by an operator through the Supabase SQL editor. Once
applied, `npm run db:verify` confirms it in one command.

**Bug found and fixed during P0:** the hardening migration was unappliable to
any legacy database that had customer rows. See §"P0 findings" below.

---

## P1 — Security

| # | Task | Files to change | Notes |
| --- | --- | --- | --- |
| 6 | Move HMAC verification before DTO validation | **new** `src/common/guards/webhook-signature.guard.ts`; `src/modules/payments/payments.controller.ts`; `src/modules/orders/orders-webhook.controller.ts` | Guards run before pipes. Verified live: a malformed unsigned POST currently returns 400 enumerating the whole DTO schema. Not a bypass — well-formed unsigned payloads already 401. |
| 7 | Replay protection on `/webhooks/chat/order` | `src/modules/orders/orders-webhook.controller.ts`; `src/modules/orders/dto/create-chat-order.dto.ts`; **new** migration adding a `chat` provider row to `webhook_events` | Reuse the existing `webhook_events` ledger rather than adding a table. |
| 8 | Event id + timestamp validation | same as #7, plus `src/common/utils/signature.util.ts` | Sign `timestamp.body`, reject outside a freshness window. |
| 9 | Review webhook tenant isolation | `src/modules/orders/orders-webhook.controller.ts`; `src/config/*` | `sellerId` is caller-supplied under one global `SOCIAL_WEBHOOK_SECRET`. Consider per-seller secrets. |

## P1 — Business correctness

| # | Task | Files to change | Notes |
| --- | --- | --- | --- |
| 10 | Expire/cancel abandoned `DEPOSIT_PENDING` orders | `src/common/enums/order-status.enum.ts` (add terminal `CANCELLED`); `src/modules/orders/orders.service.ts`; `src/modules/orders/orders.controller.ts`; **new** migration | The one place the state machine legitimately needs extending. Needs a decision: manual endpoint, scheduled sweep, or both. |
| 11 | Postgres error mapping `23505 → 409`, `23503 → 400` | `src/database/supabase/supabase.service.ts` (`unwrap`) | Confirmed harmful in practice: a real missing-table error surfaced as `"Database operation failed"`. |
| 12 | Remove float sharp edges in deposit comparison | `db/schema.sql`, `db/migrations/*` (`process_gravv_webhook`); `src/modules/orders/orders.service.ts` (`round2`) | Exact `<>` against a JS-float-derived value. Prefer a tolerance or integer minor units. |
| 13 | Verify currency handling | `src/modules/orders/orders.service.ts` (hardcoded `'TND'`) | Column is currency-aware; the insert is not. |

## P1 — Resilience

| # | Task | Files to change | Notes |
| --- | --- | --- | --- |
| 14 | Redis-backed throttling | `src/app.module.ts`; `src/config/configuration.ts`; `.env.example` | Only needed if running >1 instance. Currently 120/min **per instance**. |
| 15 | Direct `CircuitBreaker` tests | **new** `src/common/utils/circuit-breaker.spec.ts` | Currently ~7% covered. |
| 16 | Direct Orchestrator retry/backoff tests | **new** `src/modules/orchestrator/orchestrator.service.spec.ts` | Retry classification (4xx vs 408/429/5xx) is untested. |
| 17 | Real concurrency tests for optimistic locking | `test/db.integration-spec.ts` | **PARTIAL** — one real-Postgres contention test added in P0; extend to the full transition set. |

## P2 — Operations

| # | Task | Files to change |
| --- | --- | --- |
| 18 | Structured JSON logging | `src/common/interceptors/logging.interceptor.ts`; `src/main.ts` |
| 19 | Error tracking | `src/common/filters/all-exceptions.filter.ts`; `src/main.ts` |
| 20 | Docker healthcheck | `Dockerfile` |
| 21 | Verify `.dockerignore` | `.dockerignore` |
| 22 | Graceful shutdown tests | **new** `test/shutdown.e2e-spec.ts` |
| 23 | PostgreSQL job in CI | `.github/workflows/ci.yml` — **DONE** in P0 via `npm run test:db` (PGlite, no service container needed) |

---

## P0 findings

### F-1 · The hardening migration could not be applied to any legacy database with data — **fixed**

`db/migrations/20260809_backend_hardening.sql` ran, in order:

1. `alter table customers add column if not exists seller_id uuid;`
2. a guard raising if any `seller_id` was null.

The whole file executes as one transaction (the Supabase SQL editor wraps
pasted statements), so the guard's `raise exception` rolled back the ADD COLUMN
as well. The operator was told to *"Backfill customers.seller_id"* against a
column that no longer existed — an instruction impossible to follow.

Reproduced against real PostgreSQL, then fixed by adding a pre-flight guard
that detects the legacy shape **before** touching the table and names a
remediation that works. Four regression tests cover it.

### F-2 · `ALTER TYPE … ADD VALUE` inside a transaction — **no longer a risk**

The report flagged this as a possible migration hazard. Verified directly: the
migration applies cleanly wrapped in `BEGIN`/`COMMIT` on PostgreSQL 18. The new
enum value is never *used* in the same transaction, which is the actual
restriction. Closed.

### F-3 · Everything else in the SQL is sound

Confirmed against a real engine: all 5 tables, all 3 stored functions, correct
enum ordering, per-seller unique constraints, check constraints, the FK
restraint on customer deletion, the `updated_at` trigger, the partial unique
index on `payment_id`, RLS on every table, and grants restricting all three
functions to `service_role` only. `schema.sql` and both migrations are
idempotent.

---

## Deployment runbook

```bash
# 1. Apply the schema (Supabase SQL editor — needs an operator)
#    Fresh database:    paste db/schema.sql
#    Existing database: paste db/migrations/*.sql in filename order

# 2. Confirm it landed
npm run db:verify

# 3. Full verification
npm run typecheck && npm run lint && npm test && npm run test:e2e && npm run test:db && npm run build
```
