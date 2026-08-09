# CODLOCK Backend Core — Production Readiness

**Date:** 10 August 2026 · **Branch:** `backend`
**Verdict:** **NOT production-ready — one blocking operator step remains.**

The code, SQL, and tests are ready. The target Supabase database has no schema
deployed, so the real API↔database path has never executed. Per the milestone's
own rule, production-readiness is **not** claimed while that path is untested.

Test totals after this pass: **248** — 118 unit, 63 E2E, 67 real-PostgreSQL
integration. All green, plus typecheck, lint, and build.

---

## 1. Verified components

### Verified against a real PostgreSQL engine (PGlite 18, `npm run test:db`, 67 tests)

- `db/schema.sql` fresh install: all 5 tables, all indexes, enum ordering, RLS on every table, idempotent re-apply.
- All stored functions execute correctly: `record_order_outcome`, `process_gravv_webhook`, `seller_kpis`, `record_chat_webhook_event`, `release_chat_webhook_event`, `codlock_verify_schema`.
- Function grants: every function executable by `service_role` only; `anon`/`authenticated`/`public` denied.
- Constraints: per-seller uniqueness (constraint *or* index), price/total checks, currency length, risk-score range, single-order-per-`payment_id`, FK restraint on customer deletion, `updated_at` triggers.
- Optimistic locking under real two-writer contention.
- Migration path from the pre-hardening schema, including the transaction-wrapped case and the "refuses unattributable customers" guard, ending in a database that passes its own `codlock_verify_schema()`.
- `seller_kpis` correctness past 1,500 rows (the PostgREST row-limit case).

### Verified at the HTTP layer (real `AppModule`, `npm run test:e2e`, 63 tests)

- Auth: anonymous 401s, wrong-secret / non-UUID-sub / missing-sub rejection, valid token acceptance.
- Tenant isolation on orders, products, customers, risk (cross-seller → 404).
- Full order lifecycle DRAFT→REFUSED, trusted-buyer shortcut, deposit resume, illegal-jump 409s.
- **Order cancellation (P1 #5):** cancel from every pre-fulfilment state, deposit expiry on cancel, idempotent re-cancel, refusal on shipped orders.
- **Webhook signature guard (P1 #2):** unsigned/wrong/tampered → 401 **before** DTO validation; verified no schema leak to unauthenticated callers.
- **Chat replay protection (P1 #1):** duplicate event id ignored, stale timestamp rejected, event id released for genuine retry after a failed creation.
- **Postgres error mapping (P1 #4):** duplicate SKU → 409, not 500.
- Pagination, validation envelope, response/error envelope, `x-request-id`.

### Verified by unit tests (`npm test`, 118 tests)

- **CircuitBreaker (P1 #7):** CLOSED→OPEN→HALF_OPEN transitions, fail-fast when open, reset on success, exact-threshold behaviour.
- **Orchestrator retry/backoff (P1 #8):** retries 5xx/408/429 and timeouts, never retries other 4xx, exhausts to 503, forwards idempotency key, breaker integration, `ping()` semantics.
- Risk tier boundaries and degraded-mode heuristic; order state-machine table (including CANCELLED edges); HMAC accept/reject matrix; pagination math.

### Verified against the live Supabase project

- `SUPABASE_URL` reachable (HTTP 200); `SUPABASE_SERVICE_ROLE_KEY` accepted (404, not 401, on a bogus table).
- Database confirmed **empty** — PostgREST exposes no tables, views, or functions. Clean deploy; nothing to preserve.

---

## 2. Unverified components

- **The real NestJS → PostgREST → PostgreSQL write path.** Blocked: the schema is not deployed. The SQL is proven in isolation and the HTTP layer is proven against an in-memory double, but the two have never been joined against real Supabase. **This is the gating unknown.**
- **Firebase Firestore in cloud mode.** Runs against the local emulator here; cloud credentials/rules unverified. Non-critical by design (fire-and-forget, no-op on failure).
- **Live Gravv and Orchestrator endpoints.** Exercised only through stubs; no contract test against the real services.
- **Behaviour behind >1 instance.** Throttler is in-memory (see §6).

---

## 3. Security findings

| ID | Finding | Status |
| --- | --- | --- |
| S-1 | Webhook DTO validation ran before HMAC verification, leaking the schema to unauthenticated callers | **Fixed** — `WebhookSignatureGuard` runs before the pipe (P1 #2) |
| S-3 | No replay protection on the chat webhook | **Fixed** — freshness window + event-id dedup via `webhook_events` (P1 #1) |
| E-1 | DB errors collapsed to 500 (duplicate → 500 not 409) | **Fixed** — SQLSTATE mapping 23505→409, 23503→400, 23514→400 (P1 #4) |
| S-2 | Single shared `SOCIAL_WEBHOOK_SECRET`; `sellerId` caller-supplied | **Deferred by decision** — kept global; see §7 |
| S-4 | Throttler in-memory → per-instance limits | **Seam added**, not yet backed by Redis (P1 #6); see §6 |

No new vulnerabilities introduced. All function grants re-verified `service_role`-only, including the new functions.

---

## 4. Database status

- **Target project:** empty. `npm run db:verify` → 1/N checks pass (only "PostgREST reachable").
- **Schema readiness:** `db/schema.sql` and all four migrations proven to apply cleanly (fresh and upgrade paths) and are idempotent.
- **Deployment:** requires an operator — see [`db/DEPLOYMENT.md`](../db/DEPLOYMENT.md). The app's PostgREST key cannot run DDL.
- **Post-deploy verification:** `codlock_verify_schema()` (in-editor) and `npm run db:verify` (over the API) check all seven object categories.

One schema drift was found and resolved during this pass: fresh installs enforce
customer uniqueness with a table constraint, migrated databases with a unique
index. Both are valid; the verifier now checks the invariant, not the object.

---

## 5. Production blockers

1. **Deploy `db/schema.sql` to the target Supabase project** (operator; per `db/DEPLOYMENT.md`). Until then every DB-backed endpoint returns 500.
2. **Run Phase 2 real API↔DB integration** once the schema exists — the one path no test currently covers. Recommended: a scripted run against a dedicated test seller/customer/order exercising auth, tenant isolation, the full order lifecycle, risk, fitting, analytics, and the Gravv webhook end to end.

Neither is a code defect. Both are gated on the operator deployment.

---

## 6. Remaining P1 work

| # | Item | State |
| --- | --- | --- |
| 1 | Chat webhook replay protection | **Done** |
| 2 | HMAC before DTO validation | **Done** |
| 3 | Per-seller webhook secrets | **Deferred** (decision: keep global for now) |
| 4 | Postgres error mapping | **Done** |
| 5 | DEPOSIT_PENDING cancellation | **Done** (manual endpoint) |
| 6 | Redis-backed throttling | **Config seam only** — limits are env-driven and `ThrottlerModule` is async-wired; dropping in a Redis store needs one adapter + `THROTTLE_REDIS_URL`. No dependency pulled in (decision). Required before running >1 replica. |
| 7 | Direct CircuitBreaker tests | **Done** |
| 8 | Direct Orchestrator retry/backoff tests | **Done** |

## 7. Deferred / future work

- **Per-seller webhook secrets (S-2).** Kept global by decision. When needed, the least-infrastructure option is deriving `HMAC(master, sellerId)` (no new storage); a `seller_secrets` table is the alternative if rotation/revocation is required.
- **Redis throttler storage (S-4/#6).** Wire the adapter in `app.module.ts` behind `THROTTLE_REDIS_URL` before horizontal scaling.

## 8. P2 (not started — gated on P0/P1 completion)

Structured JSON logging, error tracking, Docker healthcheck, `.dockerignore` audit, graceful-shutdown tests, and a PostgreSQL service-container CI job. Note: CI already runs real-PostgreSQL SQL tests via PGlite, so the last item is partially met.

---

## 9. How to verify this report

```bash
npm run typecheck
npm run lint:ci
npm test            # 118
npm run test:e2e    # 63
npm run test:db     # 67  (real PostgreSQL via PGlite)
npm run build
npm run db:verify   # against the live Supabase project
```
