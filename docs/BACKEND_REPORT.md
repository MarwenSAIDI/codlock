# CODLOCK Backend Core — Technical Report

**Repository:** `codlock` · **Branch:** `backend` · **Version:** 0.1.0
**Report date:** 9 August 2026
**Scope:** the NestJS Backend Core only — not the Orchestrator Agent, Payment Agent, Fitting Agent, or Front App.

> This supersedes the earlier revision of this report. It reflects the state
> after the P0 hardening pass (real-database integration testing and the
> migration fix). See §14 for what changed between revisions.

---

## 1. Executive summary

CODLOCK is an AI-driven trust layer for social commerce in Tunisia. It attacks Cash-on-Delivery refusal losses with two levers: a **virtual fitting room** that shows buyers what they are actually getting, and a **risk-based deposit** charged through Gravv before shipping, sized to the buyer's refusal history.

This repository is the NestJS core that sits between the seller-facing Front App and the Codlock Orchestrator Agent. It owns the order lifecycle, tenant isolation, payment webhooks, and seller analytics.

**Overall assessment: architecturally sound, thoroughly tested, one operator step away from running.**

The layering is disciplined and several things normally done wrong at this stage are done right: optimistic locking on order updates, catalog-authoritative pricing, webhook deduplication pushed into a transactional Postgres function, and `security definer` functions with permissions revoked from `anon`/`authenticated`. The SQL — schema, migrations, and all three stored functions — is now proven against a real PostgreSQL engine, not just reviewed.

The one remaining blocker is a deployment step, not a code defect:

> **The Supabase project referenced by `.env` contains no tables.** `db/schema.sql` has never been applied to it, so every database-backed endpoint returns HTTP 500 today. The schema is proven to apply cleanly; an operator simply has to run it, because the app's PostgREST key cannot execute DDL. `npm run db:verify` confirms the state in one command.

| Dimension | State |
| --- | --- |
| Architecture & layering | Strong |
| Security posture | Good, with three open issues (P1) |
| Resilience | Strong (timeout + retry + circuit breaker + graceful degradation) |
| Test coverage | Strong — **192 tests** across unit, HTTP-level, and real-database suites |
| Database SQL correctness | **Proven** against real PostgreSQL 18 |
| CI / tooling | Lint, typecheck, three test suites, build |
| Database deployment | **Not done — blocking (operator step)** |
| Production readiness | Blocked on schema deployment; three P1 security items open |

---

## 2. How this was verified

Claims here are grounded in one of four methods. Where something was *not* verified, that is stated explicitly.

| Method | What it proves |
| --- | --- |
| **Static review** | Read all 71 production TypeScript files (~3,400 LOC) plus SQL. |
| **Unit tests (83)** | Pure logic — state machine, risk tiers, HMAC, pagination — no I/O. |
| **E2E tests (55)** | Every route over real HTTP through the actual `AppModule`, three external boundaries stubbed. |
| **Database integration tests (54)** | `db/schema.sql` and both migrations executed against a **real PostgreSQL 18 engine** (PGlite), including all three stored functions and the legacy→current upgrade path. |
| **Live smoke run** | Compiled build booted against the real `.env`; read-only HTTP checks plus targeted probes. No writes performed. |

**Still not verified:** no request has yet travelled the full path app → PostgREST → real Supabase, because the Supabase project has no schema. The SQL is proven in isolation and the HTTP layer is proven against a double; the join between them is the one untested seam, and it closes the moment the schema is deployed.

---

## 3. Architecture

```
[ Front App ] ⇄ HTTP REST ⇄ [ NestJS Backend Core ] ⇄ HTTP REST ⇄ [ Codlock Orchestrator Agent ]
                                     │                                        ├─ Get Product / CRUD Order Tools (→ Supabase)
                                     ├─ Supabase (PostgreSQL via PostgREST)   ├─ Risk Scoring Tool            (→ Firebase)
                                     └─ Firebase (Firestore)                  ├─ Payment Agent (A2A → MCP → gravvfi/mcp)
                                                                              └─ Fitting Agent (A2A → Generate Preview)
```

The core is a **secure proxy**. It never talks to Gravv or the AI agents directly — every AI-facing call funnels through `OrchestratorService`, which applies one uniform resilience policy (timeout, bounded retry, circuit breaker). That single choke point is the strongest design decision in the codebase: resilience is implemented once rather than scattered across three feature modules.

---

## 4. Databases

The backend uses **two** stores with distinct roles, plus a third engine that exists only for testing.

### 4.1 Supabase (PostgreSQL) — system of record

All transactional data. **The backend does not hold a direct SQL connection.** It talks to Supabase's **PostgREST** HTTP API through `@supabase/supabase-js` using the service-role key ([supabase.service.ts:33](../src/database/supabase/supabase.service.ts:33)).

Three consequences of that design, all load-bearing:

- **DDL cannot be run from the app or from `.env`.** PostgREST does not execute DDL, and no Postgres password or connection string exists in the repo. Schema deployment is necessarily a Supabase-SQL-editor operation.
- **PostgREST caps result sets.** This is why analytics was moved into a SQL function and why every list endpoint is paginated — an unbounded `select` silently truncates.
- **The service-role key bypasses RLS**, so the seller-authorising API is the only door to the data.

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `customers` | Buyer profile + aggregate refusal history | `unique (seller_id, phone)` |
| `products` | Seller catalog / SKUs | `unique (seller_id, sku)`, `price >= 0` |
| `orders` | Order lifecycle + deposit terms | `version` for optimistic locking; partial unique index on `payment_id` |
| `fitting_sessions` | Try-on renders | FK to order (nullable), customer, product |
| `webhook_events` | Provider event ledger | `event_id` primary key — makes redelivery idempotent |

RLS is enabled on all five tables with **no** `anon`/`authenticated` policies — a leaked anon key grants nothing.

### 4.2 Firebase Firestore — append-only event log

Risk and analytics events (`order_events`, `risk_evaluations`), consumed by the Orchestrator's Risk Scoring Tool. Deliberately non-critical: `logEvent` swallows its own errors and every call site is `void` fire-and-forget ([firebase.service.ts:68](../src/database/firebase/firebase.service.ts:68)). Absent credentials → no-op mode. The current `.env` points it at the local emulator on `127.0.0.1:8080`.

### 4.3 PGlite — test-only PostgreSQL

`@electric-sql/pglite` is real PostgreSQL 18 compiled to WASM, a **devDependency**. It runs the shipped SQL in `npm run test:db`. It ships nowhere near production.

### 4.4 Stored functions

Three `security definer` functions, each with `set search_path = public` and execute revoked from `public`/`anon`/`authenticated`, granted only to `service_role`:

| Function | Why it lives in SQL |
| --- | --- |
| `record_order_outcome(uuid, uuid, order_outcome)` | Finalises the order *and* updates the customer's aggregates and risk tier in one transaction with `select … for update`. Replays return the existing row without double-counting. |
| `process_gravv_webhook(text, text, text, numeric, text)` | Deduplication + state transition in one transaction. Validates currency and amount against the order; rolls the ledger insert back on mismatch. |
| `seller_kpis(uuid)` | Aggregates KPIs in SQL so numbers stay correct past PostgREST's row limit. |

All three are now exercised directly against real PostgreSQL — see §10.

---

## 5. Technology stack

| Concern | Choice |
| --- | --- |
| Runtime / language | Node 22, TypeScript 5.7 |
| Framework | NestJS 10 (Express platform) |
| System of record | Supabase PostgreSQL via PostgREST (`@supabase/supabase-js`, service-role key) |
| Event log | Firebase Firestore (`firebase-admin`) |
| Auth | `passport-jwt` HS256 bearer tokens (validation only — no issuance) |
| Validation | `class-validator` + `class-transformer` DTOs |
| Config | `@nestjs/config` with Joi fail-fast schema |
| HTTP client | `@nestjs/axios` |
| Hardening | `helmet`, `@nestjs/throttler` |
| Docs | `@nestjs/swagger` (OpenAPI 3), gated by env |
| Test | Jest 29, ts-jest, supertest, PGlite |
| Lint / format | ESLint 9 flat config, Prettier 3 |

---

## 6. Order lifecycle

```
DRAFT → PREVIEW_GENERATED → RISK_EVALUATED ─┬─► READY_TO_SHIP ──► SHIPPED ─┬─► ACCEPTED
                                            │        ▲                     └─► REFUSED
                          DEPOSIT_PENDING ──┴─► DEPOSIT_PAID ──────────────┘
```

Transitions are declared in `ORDER_TRANSITIONS` ([order-status.enum.ts](../src/common/enums/order-status.enum.ts)) and enforced centrally in `OrdersService.persistTransition`. Illegal moves raise `InvalidStateTransitionException` → **HTTP 409**.

**Optimistic locking.** Every transition writes with `.eq('status', order.status).eq('version', order.version)`. Zero rows affected → a concurrent writer won → 409. This is now proven under real contention against PostgreSQL (§10), not just asserted in mocks.

The transition table is verified directly, including the money-critical negatives (`DRAFT → SHIPPED`, `RISK_EVALUATED → SHIPPED`, `DEPOSIT_PENDING → READY_TO_SHIP` all impossible) and a reachability proof that every status is reachable from `DRAFT`.

---

## 7. Module reference

Concise; see the prior sections and source for detail.

- **Auth** — global `JwtAuthGuard`; `@Public()` for webhooks and health. `sub` required to be a UUID, since it is the tenant key.
- **Orchestrator** — the single outbound gateway. Retries transient failures only (`5xx`/`408`/`429`, never other `4xx`), exponential backoff, circuit breaker with `CLOSED → OPEN → HALF_OPEN`.
- **Orders** (Module 2) — lifecycle + chat-webhook ingest. **Prices come from the seller's catalog, never the client.** Trusted buyers skip the deposit.
- **Risk** (Module 4) — score → tier → deposit. Inclusive thresholds: `<40` TRUSTED/0%, `40–69` MEDIUM/10%, `≥70` HIGH/20%. Degrades to a local heuristic (first-time buyer = 65) when the scoring tool is down, flagged `fallback: true`.
- **Fitting** (Module 3) — validates customer/product/order ownership, HTTPS-only photo URLs, advances DRAFT → PREVIEW_GENERATED.
- **Payments** (Module 5) — thin controller; HMAC verify then delegate to `process_gravv_webhook`.
- **Products / Customers** — seller-scoped CRUD. Risk aggregates are **not** editable through the API.
- **Analytics** (Module 6) — thin wrapper over `seller_kpis`. Zone refusal rate over settled orders only.
- **Health** — public; uptime, orchestrator reachability, live breaker state.

---

## 8. Cross-cutting behaviour

| Concern | Implementation | Verified |
| --- | --- | --- |
| Response envelope | `{ success, data, error, meta }` on every path | e2e |
| Error handling | single `@Catch()` funnel, validator arrays flattened, no stack traces to clients | e2e |
| Validation | global pipe: `whitelist`, `forbidNonWhitelisted`, `transform` | e2e |
| Request tracing | `x-request-id` echoed into `meta.requestId` | live |
| CORS | fails closed — empty origins block all cross-origin | review |
| Rate limiting | 120 req / 60s | **live: exactly 120 then 429** |
| Pagination | `?page=&limit=` (default 1/25, max 100) | e2e + unit |
| Config | Joi validated at boot; missing key refuses to start | unit |

---

## 9. Security posture

### Strong

- **Tenant isolation is systematic** — every read/write filtered by JWT `seller_id`; cross-tenant returns 404. Proven at the HTTP layer (e2e) **and** in the stored functions against real PostgreSQL (§10).
- **RLS enabled, no client policies.**
- **Stored functions locked to `service_role`** — verified against a real engine with `has_function_privilege`.
- **HMAC verification is constant-time**, over exact raw bytes, handles `sha256=` prefix. 11 dedicated tests.
- **Prices never client-supplied; risk aggregates not API-editable; Swagger env-gated; secrets gitignored.**

### Open (all P1, not yet started per scope)

| # | Issue | Severity |
| --- | --- | --- |
| S-1 | Webhook DTO validation runs before HMAC verification — schema leaked to unauthenticated callers (not a bypass; verified). Fix: move verification into a guard. | Medium |
| S-2 | One shared `SOCIAL_WEBHOOK_SECRET` for all sellers, with caller-supplied `sellerId`. | Medium |
| S-3 | No replay protection on the chat webhook. | Medium |
| S-4 | Throttler state in-memory → per-instance limits when scaled. | Low |

---

## 10. Database integration testing (new)

`test/db.integration-spec.ts` — **54 tests** running the shipped SQL against real PostgreSQL 18 (PGlite), via the harness in [test/utils/pg-harness.ts](../test/utils/pg-harness.ts). This is the layer the e2e suite cannot reach: its in-memory Supabase double *models* the stored functions, whereas these tests *execute* them.

Fidelity notes: PostgREST is absent (this covers SQL, not REST semantics); Supabase's roles are created in-harness so grants are real; RLS is enabled but not enforced because statements run as superuser — exactly as the service-role key behaves in production.

**What it proves:**

- **Fresh install** — 5 tables, 3 functions, correct enum order (READY_TO_SHIP between DEPOSIT_PAID and SHIPPED), all list-query indexes, RLS on every table, idempotent re-apply.
- **Grants** — all three functions executable by `service_role` only; `public`/`anon`/`authenticated` denied.
- **Constraints** — per-seller uniqueness, negative-price/total rejection, 3-char currency, 0–100 risk score, one order per `payment_id` but many with none, FK restraint on customer deletion, `updated_at` trigger.
- **`record_order_outcome`** — finalisation, aggregate updates, idempotent replay, ship-state guard, tenant boundary, risk-tier recalculation at the 40%/10% thresholds.
- **`process_gravv_webhook`** — success, dedup, ledger stamping, **rollback on amount/currency mismatch** (so a corrected redelivery isn't swallowed), lowercase-currency normalisation, ALREADY_PAID, failure/expiry, unknown payment, unsupported type.
- **`seller_kpis`** — zeroed baseline, money aggregation, settled-only refusal rate, zone sorting, UNKNOWN bucketing, tenant isolation, and **correctness at 1,500 rows** (past the limit that motivated the RPC).
- **Optimistic locking** — real two-writer contention: exactly one transition wins.
- **Migration path** — the pre-hardening schema is recovered from git, upgraded for real, verified idempotent, wrapped in an explicit transaction, and confirmed to refuse a legacy database with unattributable customers.

**`npm run db:verify`** ([scripts/verify-db.ts](../scripts/verify-db.ts)) is a read-only checker for a deployed database — it probes tables and functions (mutating ones with non-existent ids so they raise and roll back) and prints a pass/fail table.

---

## 11. Testing overview

| Suite | Tests | Runner | Engine |
| --- | --- | --- | --- |
| Unit | 83 | `npm test` | none (pure logic) |
| E2E | 55 | `npm run test:e2e` | in-memory Supabase double |
| DB integration | 54 | `npm run test:db` | real PostgreSQL 18 (PGlite) |
| **Total** | **192** | | |

E2E statement coverage of production code: **84.8%**. Remaining gaps: `CircuitBreaker` (~7%) and `OrchestratorService` retry/backoff are not directly tested — both are P1 items 15–16.

---

## 12. Verification results

### All suites green

```
Typecheck        OK
Lint             OK  (0 errors, 60 warnings — all `any` in Supabase plumbing / test doubles)
Unit             83 passed
E2E              55 passed
DB integration   54 passed
Build            OK
```

Lint now covers `src/`, `test/`, and `scripts/` (previously `src/` only).

### Live smoke run

Compiled build booted against the real `.env` (port 3001; 3000 was occupied and left alone). Passed: health with live orchestrator status, Swagger `/docs-json`, all anonymous 401s, wrong-secret and bad/missing-`sub` rejections, pagination validation, UUID param validation, 404 routing. Throttler measured at exactly 120-then-429. The DB-backed endpoints return 500 for one reason only — the empty schema (`Could not find the table 'public.orders'`).

---

## 13. Findings register

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| D-1 | Supabase schema never applied — all DB endpoints 500 | **Blocking** | **Open — operator step** |
| M-1 | Hardening migration unappliable to any legacy DB with data (guard ran after ADD COLUMN; transaction rollback removed the column) | High | **Fixed** (P0) |
| B-1 | `requestDeposit` could strand an order, leaving a live payment no webhook could match | High | **Fixed** |
| B-2 | `sub` trusted without validation | High | **Fixed** |
| S-1 | Webhook DTO validation before HMAC; schema leak | Medium | Open (P1) |
| S-2 | Single shared social webhook secret | Medium | Open (P1) |
| S-3 | No chat-webhook replay protection | Medium | Open (P1) |
| A-1 | Analytics fetched all orders in memory — truncated past row limit | Medium | **Fixed** (→ `seller_kpis`) |
| A-2 | Zone refusal denominator included in-flight orders | Medium | **Fixed** |
| A-3 | List endpoints unpaginated | Medium | **Fixed** |
| S-4 | Swagger unauthenticated, no env gate | Medium | **Fixed** |
| S-5 | Helmet CSP would block Swagger assets | Low | **Fixed** |
| Q-1 | `npm run lint` broken (no config) | Medium | **Fixed** |
| Q-2 | `npm run test:e2e` pointed at missing config | Low | **Fixed** |
| Q-3 | No CI | Medium | **Fixed** |
| Q-4 | Unsafe enum comparison in exception filter | Low | **Fixed** |
| F-1 | `ALTER TYPE … ADD VALUE` flagged as a migration hazard | — | **Closed — verified safe** on PG 18 |
| E-1 | `unwrap` collapses every DB error to generic 500 (23505 should be 409) | Medium | Open (P1) |
| E-2 | Throttler in-memory | Low | Open (P1) |
| E-3 | No cancel/expire path for abandoned `DEPOSIT_PENDING` | Medium | Open (P1) |
| E-4 | Exact float-vs-numeric equality on deposit amount | Low | Open (P1) |
| E-5 | `currency` hardcoded to `'TND'` on insert | Low | Open (P1) |

---

## 14. What changed in the P0 hardening pass

**Code:** one production fix — the migration bug **M-1**. No application module was rewritten; no API contract or state machine changed.

- **[db/migrations/20260809_backend_hardening.sql](../db/migrations/20260809_backend_hardening.sql)** — added a pre-flight guard that detects the legacy shape *before* `ADD COLUMN`, so the error names a remediation that actually works. (Previously the guard ran after ADD COLUMN; because the file executes as one transaction, its rollback removed the column, leaving operators told to backfill a column that no longer existed.)

**New infrastructure:**

- `test/utils/pg-harness.ts` — real-PostgreSQL harness with Supabase roles.
- `test/db.integration-spec.ts` — 54 SQL tests (`test/jest-db.json`, `npm run test:db`).
- `scripts/verify-db.ts` — `npm run db:verify` deployment checker.
- CI gained the DB integration job; lint extended to `test/` and `scripts/` (which surfaced 3 real errors, fixed).
- [docs/HARDENING_PLAN.md](HARDENING_PLAN.md) — full P0–P2 plan mapped to files.

**Verified (previously only reviewed):** the entire `db/` tree — schema, both migrations, all three stored functions, grants, constraints, triggers, and the legacy upgrade path — now runs against a real engine. The `ALTER TYPE` hazard from the prior report was tested and closed.

---

## 15. Roadmap

### Immediate — unblocks everything (operator)

1. Apply `db/schema.sql` in the Supabase SQL editor (or the two migrations in filename order for an existing DB).
2. `npm run db:verify` to confirm.
3. Re-run the live smoke checks against the now-populated database — the one untested seam.

### P1 — security, correctness, resilience (planned, not started)

Move HMAC verification into a guard (S-1); chat-webhook replay protection (S-3); Postgres error mapping in `unwrap` (E-1); cancel/expire path for abandoned deposits (E-3); per-seller webhook secrets (S-2); Redis throttler (S-4/E-2); direct `CircuitBreaker` and Orchestrator retry tests. Details in [HARDENING_PLAN.md](HARDENING_PLAN.md).

### P2 — operations

Structured JSON logging, error tracking, Docker healthcheck, graceful-shutdown tests.

---

## Appendix A — Endpoint inventory

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/health` | Public |
| `GET` | `/orders` · `/orders/:id` | JWT |
| `POST` | `/orders` | JWT |
| `POST` | `/orders/:id/evaluate-risk` · `/request-deposit` · `/ready-to-ship` · `/ship` · `/outcome` | JWT |
| `GET` | `/products` · `/products/:id` | JWT |
| `POST` `PATCH` `DELETE` | `/products` · `/products/:id` | JWT |
| `GET` | `/customers` · `/customers/:id` | JWT |
| `POST` `PATCH` | `/customers` · `/customers/:id` | JWT |
| `POST` | `/fitting/generate-preview` · `GET /fitting/order/:orderId` | JWT |
| `POST` | `/risk/evaluate` | JWT |
| `GET` | `/analytics/kpis` | JWT |
| `POST` | `/payments/gravv/webhook` | HMAC |
| `POST` | `/webhooks/chat/order` | HMAC |

All paths relative to `API_PREFIX` (default `api/v1`).

## Appendix B — Commands

```bash
npm run start:dev    # watch-mode dev server (run from repo root)
npm run build        # compile to dist/
npm run lint         # lint src + test + scripts   (lint:fix to autofix)
npm run typecheck    # tsc --noEmit
npm test             # 83 unit tests
npm run test:e2e     # 55 HTTP-level API tests
npm run test:db      # 54 real-PostgreSQL SQL tests
npm run db:verify    # check a deployed Supabase database (read-only)
```

## Appendix C — Key environment variables

`JWT_SECRET` (≥16 chars), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FIREBASE_PROJECT_ID`, `ORCHESTRATOR_BASE_URL`, `GRAVV_API_BASE_URL`, `GRAVV_API_KEY`, `GRAVV_WEBHOOK_SECRET` are required. `SWAGGER_ENABLED` defaults on outside production. Deposit rates and risk thresholds are configurable. Full table in the prior revision and `.env.example`.
