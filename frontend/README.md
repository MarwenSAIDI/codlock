# CODLOCK demo console

The surface a judge looks at. One self-contained `index.html` — no build step, no
dependencies, no CDN. That is deliberate: nothing to install or compile on stage.

## Run it

```bash
cd frontend
python -m http.server 5173
# open http://127.0.0.1:5173
```

Opening `index.html` straight from disk works too, but serving it avoids browser
restrictions on `file://` origins.

## What it shows

Press **Run the order** and the whole pipeline plays through: a Darja conversation
arrives in the phone, the order is extracted, the try-on appears, risk scoring sweeps
to a deposit, Gravv returns a checkout link, and the order settles.

**Accepted / Refused** switches the outcome and recomputes the settlement live. That
comparison is the pitch in one screen: refused without CODLOCK the seller is down the
courier's round trip; with it the loss is zero.

## Live Gravv

Tick **Live Gravv** and the deposit step stops simulating: the page calls the Payment
Agent on `:8001`, which creates a **real Gravv sandbox collection** and returns a real
hosted checkout link you can open in front of judges. The badge flips from
`SIMULATED` to `REAL · GRAVV SANDBOX`, and the log prints the collection id and the
USD settlement amount.

Start the agent first:

```bash
cd payment-agent && npm start     # STUB_MODE=false, with a grvSec_sandbox_ key
```

If the agent is down the page says so in the log and falls back to the demo link —
it never silently pretends a simulated deposit was real.

## Honesty rules baked in

- The try-on images are **illustrations, not photographs**, and the page says so in
  an amber banner naming the reason (no image-generation quota on the project's free
  Gemini tier). Swap in real renders once quota exists.
- The payment badge always states whether the link is real or simulated.
- On a refused delivery the deposit **covers the courier's round trip and the
  remainder returns to the customer** — the seller's loss goes to zero. The product
  eliminates a loss; it does not profit from a refusal. Do not present it as profit;
  that invites a question you do not want.

## Numbers

Order 149.000 TND · deposit 20% = 29.800 TND · courier round trip 8.000 TND ·
risk 32/100. All in one `const` block at the top of the script if you want to change
the story.
