# CODLOCK agents — Payment & Fitting

Two A2A services the orchestrator talks to. **This README is the contract.** If you own
the orchestrator, everything you need to integrate is here; you do not need to read the
implementation.

```
Orchestrator ──A2A──> Payment Agent ──MCP──> @gravvfi/mcp ──> Gravv
Orchestrator ──A2A──> Fitting Agent ──────> image model
```

## Run them

No credentials needed — stub mode is the default.

```bash
cd agents
uv sync --extra dev
uv run payment-agent     # http://127.0.0.1:8001
uv run fitting-agent     # http://127.0.0.1:8002
uv run pytest            # 20 tests, all green
```

Each agent serves its card at `/.well-known/agent-card.json` and a `/health` probe.

## How to call a skill

One JSON-RPC `POST /` per call. **The `A2A-Version: 1.0` header is mandatory** — without
it the server rejects the request as protocol 0.3. That is the single most likely thing
to trip you up.

```http
POST / HTTP/1.1
A2A-Version: 1.0
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": "<any unique id>",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "<any unique id>",
      "role": "ROLE_USER",
      "parts": [{ "data": { "skill": "collect_deposit", "input": { ... } } }]
    }
  }
}
```

The reply carries one data part with the same envelope shape:

```json
{ "skill": "collect_deposit", "ok": true,  "output": { ... } }
{ "skill": "collect_deposit", "ok": false, "error": { "type": "...", "message": "..." } }
```

Always branch on `ok`. A validation failure, an unknown skill, and a dead payment
provider all come back as `ok: false` with a machine-readable `error.type` — never as an
HTTP 500.

Working example to copy from: `scripts/call_agent.py`, or `tests/test_a2a_flow.py`.

```bash
uv run python scripts/call_agent.py 8001 --card
uv run python scripts/call_agent.py 8001 collect_deposit '{"order_id": "ord_1", ...}'
```

## Payment Agent — port 8001

The agent does **not** decide the deposit. Risk scoring upstream decides it; this agent
makes it payable, watches it clear, and settles it.

| Skill | Purpose |
|---|---|
| `collect_deposit` | Amount → one-tap Gravv checkout. Idempotent on `order_id`. |
| `confirm_payment` | Poll until paid. Safe to call repeatedly. |
| `settle_order` | Courier reported back; apply or retain the deposit. |

### `collect_deposit`

```jsonc
// input
{
  "order_id": "ord_demo_1",          // idempotency anchor — same id never opens twice
  "seller_id": "S456",
  "customer": {
    "customer_id": "C123",
    "full_name": "Amira Ben Salah",
    "phone": "+21620123456",         // E.164
    "zone": "Ariana"                 // audit only
  },
  "order_total":  { "amount": "149.000", "currency": "TND" },
  "deposit":      { "amount": "29.800", "currency": "TND" },
  "deposit_rate": 0.2,               // audit only
  "risk_score":   32,                // audit only
  "channel":      "instagram"        // or "whatsapp"
}

// output
{
  "payment_id": "pay_a1b2c3d4e5f6",
  "order_id": "ord_demo_1",
  "status": "awaiting_payment",
  "amount": { "amount": "29.800", "currency": "TND" },
  "checkout_url": "https://checkout.sandbox.gravv.xyz/...",
  "expires_at": "2026-08-09T14:00:00Z",
  "gravv": { "seller_account_id": "acc_...", "collection_id": "pi_...",
             "environment": "sandbox" }
}
```

**A deposit of `"0"` is legal.** A clean returning customer pays nothing: the agent
returns `status: "not_required"` with `checkout_url: null` and never calls Gravv. Handle
that branch — it is a feature, not an edge case.

### `confirm_payment`

Input `{ "payment_id", "order_id" }` → `status` of `awaiting_payment` → `paid`, plus
`paid` amount and `paid_at`.

**Poll it.** In stub mode the first call deliberately returns `awaiting_payment` and
clears from the second onward, so that code written against the stub still works when a
real customer takes forty seconds to tap.

### `settle_order`

Input `{ "payment_id", "order_id", "outcome": "accepted" | "refused", "courier_fee"? }`.
`courier_fee` is required when refused.

| Situation | `disposition` | Also returned |
|---|---|---|
| Accepted, deposit paid | `applied_to_total` | `remaining_due` = total − deposit |
| Refused, deposit paid | `retained_for_courier` | `courier_covered`, `seller_shortfall` |
| No deposit, or never paid | `nothing_to_settle` | `seller_shortfall` = full courier fee |

`seller_shortfall` is reported honestly rather than zeroed. An abandoned checkout settles
as if no deposit existed — that is the status quo CODLOCK removes, and hiding it would
make the demo lie.

Money is always a **string** decimal, never a JSON number. TND has three decimal places
and floats lose millimes.

## Fitting Agent — port 8002

| Skill | Purpose |
|---|---|
| `generate_preview` | Start a try-on render. Returns instantly. Idempotent on `request_id`. |
| `get_preview` | Poll for the result. |

A render takes 10–30 seconds, far too long to hold a request open while a customer waits
in a chat. `generate_preview` returns `status: "processing"` immediately; poll
`get_preview` with the returned `preview_id`.

```jsonc
// generate_preview input
{
  "request_id": "req_demo_1",        // idempotency anchor
  "order_id": "ord_demo_1",
  "customer_photo_url": "https://.../customer.jpg",
  "product": {
    "sku": "DRESS-BEIGE-001", "name": "Beige Summer Dress",
    "image_url": "https://.../dress.jpg", "category": "dress",
    "color": "beige", "size": "M"
  }
}

// get_preview output once ready
{
  "preview_id": "prv_...", "request_id": "req_demo_1", "status": "ready",
  "preview_image_url": "https://.../preview.png",
  "match": { "quality": 0.86, "verdict": "good_match",
             "reason": "...", "recommend_alternative": false },
  "from_cache": false
}
```

**On `recommend_alternative: true`, you fetch the alternative.** The Fitting Agent has no
catalog access by design — that is your Get-product tool. It reports that the item reads
poorly on this customer; choosing what to offer instead stays with one owner, you.

**`from_cache`** tells you the render came from the pre-rendered fixture set rather than
a live model. It exists so a demo never silently pretends.

**A failed render must not block the order.** On `status: "failed"` (or a timeout),
continue to risk scoring without a preview. The deposit still works; you just lose the
behavioural half for that order.

## Configuration

Copy `.env.example` to `.env`. `STUB_MODE=true` is the default and needs no credentials.

Turning stub mode off requires `GRAVV_API_KEY` (sandbox) for payments and
`GEMINI_API_KEY` for renders; each agent fails fast at startup with a clear message
rather than at the first request.

## Notes for the pitch

- **The Payment Agent runs no LLM.** Money movement is a fixed sequence of calls.
  An LLM improvising over payment tools is what breaks on stage. The intelligence sits
  in risk scoring and the fitting room, where being wrong is cheap.
- **Gravv gates money movement behind a two-call `confirm: true` preview.** The agent
  performs that handshake deliberately rather than routing around it.
- **Gravv holds value in stablecoin and quotes card collections in USD**, while orders
  are priced in TND. The displayed currency stays TND end to end; what Gravv actually
  settles is reported back in `gravv.settlement`.
