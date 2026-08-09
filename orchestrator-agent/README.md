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
uv run pytest               # 20 tests, no live credentials needed
```

Serves its card at `/.well-known/agent-card.json` and a `/health` probe, same as every
other CODLOCK agent.

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
| Product lookup | `get_product_tool` — reads the `products` table in Supabase. |
| Risk scoring, order get/create/delete | Internal tools, not implemented yet — placeholders that raise `NotImplementedError` until owned. |
| Try-on preview | Delegated to the Fitting Agent over A2A (`fitting` in `A2A_AGENTS`). |
| Deposit collection and settlement | Delegated to the Payment Agent over A2A (`payment` in `A2A_AGENTS`). |

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
  server.py     # to_a2a() wiring + uvicorn entry point
tests/
  test_tools.py       # internal tools against a fake Supabase client
  test_agent.py        # agent/tool/peer wiring, no live services
  test_a2a_server.py    # the actual A2A surface: agent card, health probe
scripts/
  call_agent.py  # CLI smoke-test client, shared shape with the other agents
```
