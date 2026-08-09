# CODLOCK Orchestrator Agent

The orchestrator: an LLM agent (Google ADK) that fulfills orders by calling its own
tools — risk scoring, product lookup, order management — and delegating to specialized
peers discovered over A2A (the Payment Agent, the Fitting Agent). **This README is the
contract** — if you own the backend calling this agent, or a peer agent it delegates to,
everything you need is here.

Python, like the Fitting Agent in `../fitting-agent`. A2A is language-agnostic, so
callers cannot tell and do not care.

## Run it

Needs a model endpoint and a Supabase project — the orchestrator has no stub mode,
because product lookup and order fulfillment have nothing to answer without them.

```bash
cd orchestrator-agent
cp .env.example .env   # fill in MODEL_*, A2A_AGENTS, SUPABASE_*
uv sync --extra dev
uv run orchestrator-agent   # http://127.0.0.1:8000
uv run pytest               # 53 tests, no live credentials needed
```

Serves its card at `/.well-known/agent-card.json` and a `/health` probe, same as every
other CODLOCK agent — plus the three REST routes the backend calls, below.

## Two surfaces, one port

| Surface | Path | Who calls it |
|---|---|---|
| A2A agent | `/` (JSON-RPC), `/.well-known/agent-card.json` | peer agents, `google-adk` clients |
| REST bridge | `POST /agent/risk/score`, `POST /agent/fitting/generate-preview`, `POST /agent/payment/create-link` | the NestJS backend |
| Ops | `GET /health` | everyone; also lists the bridge routes |

**Why a REST bridge and not "the backend speaks A2A".** The backend's single outbound
gateway (`backend/src/modules/orchestrator/orchestrator.service.ts`) wraps every call in a
timeout, bounded retries and a circuit breaker, all keyed on **HTTP status codes** — while
A2A reports a handled failure as `ok: false` inside a *200*. Bridging here keeps those
statuses meaningful (404 unknown product, 409 a deposit that contradicts an existing
checkout, 502 a peer that refused, 504 a render that ran long) and leaves the backend
untouched.

The bridge is also where four contract differences get reconciled — each of which
otherwise fails a call quietly:

1. **money**: a JSON number in the backend, a decimal *string* in the peers. TND has three
   decimal places and IEEE floats lose millimes.
2. **channel**: `WHATSAPP` in the Postgres enum, `whatsapp` in the Payment Agent's zod.
3. **products**: the backend sends an id; the Fitting Agent needs a whole `ProductRef`
   (sku, name, image, category), so the row is looked up here. Note `products.title` in
   Postgres is `name` on the wire, and `sizes`/`colors` are arrays.
4. **timing**: fitting is asynchronous — `generate_preview` returns `processing` and a
   render takes 10-30s — while the backend awaits one call, so the polling loop lives here
   and is bounded.

To check the seam against the live agents rather than fakes:

```bash
# with the peers running in STUB_MODE=true
uv run python scripts/smoke_bridge.py
```

## How it exposes to A2A

Unlike the Fitting Agent's hand-built skill router, this agent's behaviour comes from an
LLM plus tools, so it is exposed with `google-adk`'s `to_a2a()`: it inspects the agent
definition (instruction, tools, peers) and builds the JSON-RPC routes and agent card
directly from it. `src/codlock_agents/orchestrator/server.py` is the thin layer that
wires settings to the agent and serves the result — the same split fitting-agent draws
between `server.py` (what the agent does) and `serving.py` (how it is served).

```bash
uv run python scripts/call_agent.py 8000 --card
uv run python scripts/call_agent.py 8000 --text "look up SKU DRESS-BEIGE-001 in size M"
```

The same script works against the Fitting Agent (`:8002`) and the Payment Agent (`:8001`)
— all three speak the same protocol.

## What it does

| Concern | How |
|---|---|
| Product lookup | `get_product_tool` — reads `products` in Supabase. A size narrows by array containment on `sizes`, because that column is a `text[]`. |
| Risk scoring | `risk_score_tool` and `POST /agent/risk/score`, both over `risk.py` — one implementation, so the tool and the backend can never disagree about what a score means. |
| Order get/create/delete | `get_order_tool`, `create_order_tool`, `delete_order_tool` on Supabase. Deleting is refused from `DEPOSIT_PENDING` onwards: past that point the row is a financial record, and cancelling is the backend's job. |
| Try-on preview | Delegated to the Fitting Agent over A2A (`fitting` in `A2A_AGENTS`). |
| Deposit collection and settlement | Delegated to the Payment Agent over A2A (`payment` in `A2A_AGENTS`). |

Every tool returns a plain dict and reports trouble as `{"error": "..."}` rather than
raising: the caller is an LLM, and an exception is an opaque tool failure it cannot explain,
while a sentence is something it can act on.

**Risk scoring**, specifically: a customer's own refusal rate, plus their zone's refusal
rate weighted at 20 points. A first-time buyer scores 65 — deliberately the same number the
backend's local fallback uses, so an orchestrator outage does not move anyone's deposit.

Peers are configured with `A2A_AGENTS=name=url,...`; each peer's card is resolved from
`{url}/.well-known/agent-card.json` lazily, on the orchestrator's first delegation to it
— see `../fitting-agent/README.md` and `../payment-agent/README.md` for what each peer
actually expects on the wire.

## Configuration

Copy `.env.example` to `.env`. Every value is required — a missing `MODEL_*` or
`SUPABASE_*` variable fails the agent at startup with a clear validation error, rather
than the first time a customer's request needs it.

`MODEL_NAME` is a LiteLLM-style model id (e.g. `openai/gpt-4o`, `anthropic/claude-sonnet-5`)
resolved against `MODEL_API_URL` / `MODEL_API_KEY`.

## Structure

```
src/codlock_agents/orchestrator/
  settings.py   # env-backed config (pydantic-settings)
  agent.py      # tools + root agent assembly (build_agent)
  risk.py       # the risk score, shared by the tool and the REST route
  peers.py      # structured A2A calls to the peer agents (no LLM in the loop)
  bridge.py     # the /agent/* REST routes the NestJS backend calls
  server.py     # to_a2a() wiring, /health, bridge mount, uvicorn entry point
tests/
  test_tools.py        # internal tools against a fake Supabase client
  test_agent.py        # agent/tool/peer wiring, no live services
  test_a2a_server.py   # the actual A2A surface: agent card, health probe
  test_bridge.py       # the backend's three routes, and the contract translations
scripts/
  call_agent.py   # CLI smoke-test client, shared shape with the other agents
  smoke_bridge.py # the bridge against the *live* peers, only Supabase faked
```
