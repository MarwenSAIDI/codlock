# CODLOCK — Backend Core

AI-driven trust & confidence layer for social e-commerce (Instagram & WhatsApp),
built to eliminate Cash-on-Delivery (COD) refusal losses in Tunisia.

Two levers:

1. **Fitting Room** — realistic virtual try-on previews before purchase.
2. **Risk-Based Deposit** — a dynamic deposit (e.g. 20%) charged via **Gravv**
   before shipping, sized to the customer's risk history.

## Architecture

<img width="1840" height="751" alt="CODLOCK architecture" src="https://github.com/user-attachments/assets/6208d774-d50f-48ad-93c6-a0706b156f5e" />

**Programming stack** — TypeScript/JavaScript and Python across the fleet:
Backend (TS), Payment Agent (TS), Codlock Agent (TS), Fitting Agent (Python).
This repository is the **NestJS Backend Core**.

```
[ Front App ] ⇄ HTTP REST ⇄ [ NestJS Backend Core ] ⇄ HTTP REST ⇄ [ Codlock Orchestrator Agent ]
                                                                         ├─ Get Product / CRUD Order Tools (→ Supabase)
                                                                         ├─ Risk Scoring Tool           (→ Firebase)
                                                                         ├─ Payment Agent  (A2A → MCP → gravvfi/mcp)
                                                                         └─ Fitting Agent  (A2A → Generate Preview)
```

The NestJS core is the secure proxy between the Front App and the Orchestrator.
Every AI-facing call goes through `OrchestratorService`, which applies uniform
**timeout + bounded retry + circuit breaker** resilience.

## Order lifecycle

```
DRAFT → PREVIEW_GENERATED → RISK_EVALUATED
  ├─ zero deposit → READY_TO_SHIP
  └─ deposit required → DEPOSIT_PENDING → DEPOSIT_PAID → READY_TO_SHIP
READY_TO_SHIP → SHIPPED → ACCEPTED | REFUSED
```

Transitions are enforced by a state machine (`src/common/enums/order-status.enum.ts`);
illegal moves return HTTP 409.

## Project structure

```
src/
├─ main.ts                     # bootstrap: Swagger, validation, helmet, rawBody, CORS
├─ app.module.ts               # root wiring + global filter/interceptors/guards
├─ config/                     # typed configuration + Joi env validation
├─ common/                     # cross-cutting: enums, DTO envelope, filters,
│  ├─ enums/                   #   interceptors, decorators, exceptions, utils
│  ├─ dto/  filters/  interceptors/  decorators/  exceptions/  utils/
├─ database/
│  ├─ supabase/                # PostgreSQL: catalog, orders, customers, SKUs
│  └─ firebase/                # risk logs & real-time analytics (no-op if unset)
└─ modules/
   ├─ auth/                    # JWT strategy + global JwtAuthGuard (+ @Public)
   ├─ orchestrator/            # resilient HTTP client to the Codlock Agent
   ├─ customers/               # customer profiles + refusal history
   ├─ products/                # seller catalog / SKUs
   ├─ fitting/                 # Module 3 — virtual try-on
   ├─ risk/                    # Module 4 — scoring + dynamic deposit engine
   ├─ orders/                  # Module 2 — lifecycle + chat webhook ingest
   ├─ payments/                # Module 5 — Gravv link + webhook receiver
   ├─ analytics/               # Module 6 — seller KPIs
   └─ health/                  # liveness + downstream status
db/schema.sql                  # Supabase PostgreSQL schema
```

## Getting started

```bash
npm install
cp .env.example .env      # fill in real values
# apply db/schema.sql in the Supabase SQL editor
npm run start:dev
```

For a database created from the earlier schema, apply the migrations in
`db/migrations/` in filename order:

1. `20260809_backend_hardening.sql` — existing customer rows must be backfilled
   with their owning `seller_id`; the migration deliberately refuses to guess
   ownership.
2. `20260809_kpis_rpc_and_indexes.sql` — the `seller_kpis` aggregation function
   and the indexes backing the paginated list endpoints.

A disposable development database can be recreated from `db/schema.sql`
instead, which already includes both.

If the legacy `customers` table has rows, the hardening migration refuses
before changing anything and tells you what to run: add the `seller_id`
column, set every row to its owning seller, then re-apply.

After applying, confirm the deployment landed:

```bash
npm run db:verify
```

`db/schema.sql` and both migrations are exercised against a real PostgreSQL
engine by `npm run test:db`, which also covers all three stored functions.

Order creation accepts product ids, variants, and quantities. Product titles
and prices are loaded from the authenticated seller's catalog by the backend;
callers cannot submit authoritative prices.

Set `JWT_ISSUER` and `JWT_AUDIENCE` to the values issued by the seller identity
provider. When configured, tokens with a different issuer or audience are
rejected in addition to the HS256 signature and expiry checks.

- API base: `http://localhost:3000/api/v1`
- Swagger UI: `http://localhost:3000/api/v1/docs`

The docs route is unauthenticated, so it is mounted only when
`SWAGGER_ENABLED` is true — which it is by default everywhere except
`NODE_ENV=production`. Set `SWAGGER_ENABLED=true` to opt back in deliberately.

## Key endpoints

| Method | Path                          | Purpose                                           |
| ------ | ----------------------------- | ------------------------------------------------- |
| `GET`  | `/orders`                     | List orders (paginated)                           |
| `POST` | `/orders`                     | Create a DRAFT order (dashboard)                  |
| `POST` | `/orders/:id/evaluate-risk`   | Run risk engine → attach deposit terms            |
| `POST` | `/orders/:id/request-deposit` | Generate Gravv deposit link (or skip for trusted) |
| `POST` | `/orders/:id/ready-to-ship`   | Verify paid deposit and mark ready                |
| `POST` | `/orders/:id/ship`            | Ship an order that is ready                       |
| `POST` | `/orders/:id/outcome`         | Record ACCEPTED / REFUSED                         |
| `POST` | `/fitting/generate-preview`   | Virtual try-on                                    |
| `POST` | `/risk/evaluate`              | Standalone risk + deposit calculation             |
| `GET`  | `/analytics/kpis`             | Seller KPIs                                       |
| `POST` | `/payments/gravv/webhook`     | Gravv deposit confirmations (HMAC-verified)       |
| `POST` | `/webhooks/chat/order`        | NLP chat order ingest (HMAC-verified)             |
| `GET`  | `/health`                     | Liveness + orchestrator/breaker status            |

## Cross-cutting behaviour

- **Response envelope** — every response is `{ success, data, error, meta }`
  (success via `ResponseInterceptor`, failure via `AllExceptionsFilter`).
- **Pagination** — `GET /orders`, `/products`, and `/customers` take
  `?page=&limit=` (defaults 1 / 25, max 100) and return
  `{ items, total, page, limit, hasMore }` as `data`. Unpaginated list reads
  were silently truncated by PostgREST's row limit.
- **Auth subject** — the seller id comes from the token's `sub` claim, which is
  required to be a UUID. Every tenant-scoped query keys off it.
- **Validation** — global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted`
  - `transform`; all inputs are `class-validator` DTOs.
- **Auth** — global `JwtAuthGuard`; webhooks and `/health` are `@Public()` and
  instead verified by HMAC-SHA256 signatures over the raw request body.
- **Tenant isolation** — resource queries are scoped by the seller id from the
  verified JWT; direct anon/authenticated Supabase table access is blocked by
  RLS.
- **Payment safety** — payment creation carries a stable idempotency key and
  provider webhooks are deduplicated and applied transactionally in PostgreSQL.
- **Resilience** — `OrchestratorService` retries transient failures with
  exponential backoff and trips a circuit breaker to fail fast when the AI
  services are down; the risk engine degrades to a local heuristic.

## Scripts

| Script                              | Description             |
| ----------------------------------- | ----------------------- |
| `npm run start:dev`                  | Watch-mode dev server   |
| `npm run build`                      | Compile to `dist/`      |
| `npm run start:prod`                 | Run compiled build      |
| `npm run lint` / `npm run lint:fix`  | Lint (optionally fixing)|
| `npm run typecheck`                  | `tsc --noEmit`          |
| `npm test` / `npm run test:cov`      | Unit tests / coverage   |
| `npm run test:e2e`                   | HTTP-level API tests    |
| `npm run test:db`                    | SQL tests on real Postgres |
| `npm run db:verify`                  | Check a deployed database  |
| `npm run format`                     | Prettier                |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, both test suites, and
build on pushes to `main`/`backend` and on PRs into `main`.

`test/api.e2e-spec.ts` drives every route over real HTTP through the actual
`AppModule` — same guards, pipes, interceptors and exception filter as
`main.ts` — with Supabase, Firebase and the Orchestrator replaced by test
doubles (`test/utils/`). It therefore verifies routing, auth, validation,
tenant scoping, the order state machine and webhook HMAC handling, but **not**
the SQL in `db/`: the in-memory double models those functions rather than
running them. Schema changes still need a real Supabase instance.
