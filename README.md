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
DRAFT → PREVIEW_GENERATED → RISK_EVALUATED → DEPOSIT_PENDING → DEPOSIT_PAID → SHIPPED → ACCEPTED | REFUSED
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

- API base: `http://localhost:3000/api/v1`
- Swagger UI: `http://localhost:3000/api/v1/docs`

## Key endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/orders` | Create a DRAFT order (dashboard) |
| `POST` | `/orders/:id/evaluate-risk` | Run risk engine → attach deposit terms |
| `POST` | `/orders/:id/request-deposit` | Generate Gravv deposit link (or skip for trusted) |
| `PATCH`| `/orders/:id/status` | Manual transition (e.g. mark SHIPPED) |
| `POST` | `/orders/:id/outcome` | Record ACCEPTED / REFUSED |
| `POST` | `/fitting/generate-preview` | Virtual try-on |
| `POST` | `/risk/evaluate` | Standalone risk + deposit calculation |
| `GET`  | `/analytics/kpis` | Seller KPIs |
| `POST` | `/payments/gravv/webhook` | Gravv deposit confirmations (HMAC-verified) |
| `POST` | `/webhooks/chat/order` | NLP chat order ingest (HMAC-verified) |
| `GET`  | `/health` | Liveness + orchestrator/breaker status |

## Cross-cutting behaviour

- **Response envelope** — every response is `{ success, data, error, meta }`
  (success via `ResponseInterceptor`, failure via `AllExceptionsFilter`).
- **Validation** — global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted`
  + `transform`; all inputs are `class-validator` DTOs.
- **Auth** — global `JwtAuthGuard`; webhooks and `/health` are `@Public()` and
  instead verified by HMAC-SHA256 signatures over the raw request body.
- **Resilience** — `OrchestratorService` retries transient failures with
  exponential backoff and trips a circuit breaker to fail fast when the AI
  services are down; the risk engine degrades to a local heuristic.

## Scripts

| Script | Description |
| --- | --- |
| `npm run start:dev` | Watch-mode dev server |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run compiled build |
| `npm run lint` / `npm run format` | Lint / format |
