# CODLOCK Fitting Agent

An A2A service that renders the matched catalog item on the customer's own photo, before
any money is asked for. **This README is the contract** — if you own the orchestrator,
everything you need is here.

Python. The Payment Agent is TypeScript, in `../payment-agent`. A2A is language-agnostic,
so callers cannot tell and do not care.

## Run it

No credentials needed — stub mode is the default.

```bash
cd fitting-agent
uv sync --extra dev
uv run fitting-agent    # http://127.0.0.1:8002
uv run pytest           # 12 tests
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
      "parts": [{ "data": { "skill": "generate_preview", "input": { ... } } }]
    }
  }
}
```

**The `A2A-Version: 1.0` header is mandatory.** Without it the server rejects the call
as protocol 0.3. This trips up every new client exactly once.

### Plain text (google-adk `RemoteA2aAgent`)

Delegating in natural language works. A text part is run through Gemini, which
transcribes it into the same schema, which is then validated exactly as above. If it
invents a field, validation rejects it before anything renders. With `GEMINI_API_KEY`
unset, free text is refused with `extraction_failed` rather than guessed at.

### The reply

```json
{ "skill": "generate_preview", "ok": true,  "output": { ... } }
{ "skill": "generate_preview", "ok": false, "error": { "type": "...", "message": "..." } }
```

Branch on `ok`. Everything — bad input, unknown skill, dead image model — arrives as
`ok: false` with a machine-readable `error.type`, never an HTTP 500.

```bash
uv run python scripts/call_agent.py 8002 --card
uv run python scripts/call_agent.py 8002 generate_preview '{"request_id": "req_1", ...}'
uv run python scripts/call_agent.py 8002 --text "try the beige dress on her"
```

That script works against the Payment Agent on :8001 too — same protocol.

## Skills

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
  "from_cache": false, "failure_reason": null
}
```

**On `recommend_alternative: true`, you fetch the alternative.** This agent has no
catalog access by design — that is your Get-product tool. It reports that the item reads
poorly on this customer; choosing what to offer instead stays with one owner, you.

**`from_cache`** tells you the render came from the pre-rendered fixture set rather than
a live model. It exists so a demo never silently pretends.

**A failed render must not block the order.** On `status: "failed"` or a timeout,
continue to risk scoring without a preview. The deposit still works; you lose the
behavioural half for that order, not the order.

## Configuration

Copy `.env.example` to `.env`. `STUB_MODE=true` is the default and needs no credentials.

Turning stub mode off requires `GEMINI_API_KEY`; the agent fails fast at startup with a
clear message rather than at the first request.

`GEMINI_IMAGE_MODEL` defaults to `gemini-3-pro-image` (Nano Banana Pro) for fidelity —
the render is what judges are looking at. Switch to `gemini-3.1-flash-image` if renders
run long on the day.
