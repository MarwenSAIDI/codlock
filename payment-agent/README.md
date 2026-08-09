# CODLOCK Payment Agent

An A2A service that turns a risk-decided deposit into money in the seller's Gravv
account, and settles it once the courier reports back. **This README is the contract** —
if you own the orchestrator, everything you need is here.

TypeScript. The Fitting Agent is Python, in `../fitting-agent`. A2A is language-agnostic,
so callers cannot tell and do not care.

## Run it

No credentials needed — stub mode is the default.

```bash
cd payment-agent
npm install
npm start          # http://127.0.0.1:8001
npm test           # 20 tests
npm run typecheck
```

Serves its card at `/.well-known/agent-card.json` and a `/health` probe.

## How to call it

Two call styles work. Both reach the same validated handlers.

### Structured (preferred — no model involved)

```http
POST / HTTP/1.1
A2A-Version: 1.0
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": "<unique>",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "<unique>",
      "role": "ROLE_USER",
      "parts": [{ "data": { "skill": "collect_deposit", "input": { ... } } }]
    }
  }
}
```

**The `A2A-Version: 1.0` header is mandatory.** Without it the server rejects the call
as protocol 0.3. This trips up every new client exactly once.

Note the wire shape is `parts: [{ "data": ... }]`, not the SDK's in-memory
`{ content: { $case: "data" } }` form.

### Plain text (google-adk `RemoteA2aAgent`)

Delegating in natural language works too. A text part is run through Gemini, which
transcribes it into the same schema, which is then validated exactly as above. The model
**only parses** — it never picks an amount, never chooses an outcome, and never talks to
Gravv. If it invents a field, validation rejects it and you get `invalid_input`, not a
payment.

If `GEMINI_API_KEY` is unset, free text is refused with `extraction_failed` rather than
guessed at. A JSON envelope pasted into a text part is handled directly, with no model.

### The reply

One data part, always this shape:

```json
{ "skill": "collect_deposit", "ok": true,  "output": { ... } }
{ "skill": "collect_deposit", "ok": false, "error": { "type": "...", "message": "..." } }
```

Branch on `ok`. A validation failure, an unknown skill, and a dead payment provider all
arrive as `ok: false` with a machine-readable `error.type` — never an HTTP 500.

Working example to copy: `test/flow.test.ts`. The Python smoke-test CLI in
`../fitting-agent/scripts/call_agent.py` works against this agent too — same protocol.

## Skills

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
  "order_id": "ord_demo_1",          // idempotency anchor — never opens two checkouts
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
  "expires_at": "2026-08-09T14:00:00.000Z",
  "gravv": { "seller_account_id": "acc_...", "collection_id": "pi_...",
             "environment": "sandbox" },
  "failure_reason": null
}
```

**A deposit of `"0"` is legal.** A clean returning customer pays nothing: status is
`not_required`, `checkout_url` is null, and Gravv is never called. Handle that branch —
it is a feature, not an edge case.

**Money is a decimal string, never a JSON number.** `"29.800"`, not `29.8`. TND has
three decimal places and IEEE floats lose millimes; a numeric amount is rejected.

### `confirm_payment`

Input `{ "payment_id", "order_id" }` → `status` moves `awaiting_payment` → `paid`, with
`paid` amount and `paid_at`.

**Poll it.** In stub mode the first call deliberately returns `awaiting_payment` and
clears from the second onward, so code written against the stub still works when a real
customer takes forty seconds to tap.

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

## Going live against Gravv

Set `STUB_MODE=false` with a `grvSec_sandbox_` key and `GRAVV_SELLER_ACCOUNT_ID`
(from `listAccounts`). Verified working end to end against the sandbox: a 29.800 TND
deposit becomes a 9.61 USD collection and a real hosted checkout link.

Three things the docs do not tell you, learned against the live sandbox:

- **`createCustomer` wraps its fields in a `body` object.** Flat fields fail with a bare
  `EOF`.
- **The collection's country comes from the customer record, not the request.** A
  customer with no address gives `payment method 'card' is not available for country ''`
  no matter what `country` you send. The agent therefore creates each customer with a
  TN address before its first deposit.
- **`getCollection` currently fails through the MCP** with `x-tenant-id is missing`.
  Confirmation falls back to scanning `listTransactions` for our `client_reference`.
  Gravv's collections webhook is the durable fix and is the next piece of work.

## Configuration

Copy `.env.example` to `.env`. `STUB_MODE=true` needs no credentials.

Turning stub mode off requires a Gravv sandbox key; the agent fails fast at startup with
a clear message rather than at the first request.

## Notes for the pitch

- **No LLM decides anything about money here.** Deposits follow a fixed call sequence.
  The only model in the process transcribes a sentence into a schema that is then
  validated — and if it is wrong, the request is rejected rather than executed.
- **Gravv gates money movement behind a two-call `confirm: true` preview**
  (`createTransfer`, `chargeSavedCard`, and friends). The agent performs that handshake
  deliberately rather than routing around it. Taking money *in* via
  `createCardPaymentIntent` is not gated, because inbound is not the dangerous direction.
- **Gravv holds value in stablecoin** and quotes card collections in USD, while orders
  are priced in TND. Displayed currency stays TND end to end; what Gravv actually settles
  comes back in `gravv.settlement`.
