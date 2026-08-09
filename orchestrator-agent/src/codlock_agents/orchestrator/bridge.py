"""The REST surface the NestJS backend calls, bridged onto A2A and Supabase.

**Why this file exists.** ``backend/src/modules/orchestrator/orchestrator.service.ts``
is the backend's single outbound gateway, and it speaks plain HTTP to three fixed paths:

===================================== =========================================
``POST /agent/risk/score``            Module 4 — risk & dynamic deposit
``POST /agent/fitting/generate-preview`` Module 3 — virtual fitting room
``POST /agent/payment/create-link``   Module 5 — deposit link through Gravv
===================================== =========================================

The orchestrator, meanwhile, is an ADK agent served by ``to_a2a`` — it answers JSON-RPC
at ``/`` and publishes a card at ``/.well-known/agent-card.json``, and knows nothing
about those three paths. So every AI-facing call from the backend used to 404, retry
three times, trip the circuit breaker and surface as *"Codlock Orchestrator is currently
unavailable"*. Risk degraded to a local heuristic and hid it; fitting and payment simply
failed. This module is the missing half of that seam.

**Why REST and not "make the backend speak A2A".** The backend's resilience — timeout,
bounded retry, circuit breaker — is built around HTTP status codes, and A2A reports
handled failures as ``ok: false`` inside a *200* response. Bridging here keeps the
statuses meaningful (404 for an unknown product, 502 for a peer that refused, 504 for a
render that ran long) and leaves the backend untouched.

**Translation is the substance of this file.** The backend and the peers were written by
different people in different languages, and their contracts differ in four ways that
each break a call silently:

1. money is a JSON *number* in the backend and a decimal *string* in the peers — TND has
   three decimal places and IEEE floats lose millimes;
2. ``channel`` is ``WHATSAPP`` in Postgres and ``whatsapp`` in the Payment Agent's zod;
3. the backend sends a product **id**; the Fitting Agent needs a whole ``ProductRef``
   (sku, name, image, category), so the row has to be looked up here;
4. fitting is *asynchronous* — ``generate_preview`` returns ``processing`` and a render
   takes 10-30s — while the backend awaits one call, so the polling loop lives here.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from codlock_agents.orchestrator.peers import PeerClient, PeerError, PeerNotConfigured
from codlock_agents.orchestrator.risk import CustomerNotFound, score_customer

logger = logging.getLogger(__name__)

FITTING_PEER = "fitting"
PAYMENT_PEER = "payment"

#: TND is quoted in millimes. Three places, always, on every amount crossing to a peer.
MONEY_PLACES = 3

#: A peer's own error type, mapped to the status the backend should see. Anything absent
#: is treated as 502 — the peer broke, and retrying is worth a try. Everything listed here
#: is a *caller* error, where three retries would only waste the customer's time.
PEER_ERROR_STATUS = {
    "invalid_input": 400,
    "unknown_skill": 400,
    # The Payment Agent refusing a changed deposit under an existing idempotency key.
    "ConflictError": 409,
    "no_image": 502,
    "render_failed": 502,
}


# ── request bodies ────────────────────────────────────────────────────────────
# Field names are the backend's camelCase wire contract, carried as aliases so the
# Python side stays snake_case. extra="ignore" on purpose: the backend adding an
# optional field must not 400 the whole call.


class _Body(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class RiskScoreBody(_Body):
    customer_id: str = Field(alias="customerId")
    phone: str | None = None
    zone: str | None = None
    channel: str | None = None
    order_value: float | None = Field(default=None, alias="orderValue")


class GeneratePreviewBody(_Body):
    customer_id: str = Field(alias="customerId")
    product_id: str = Field(alias="productId")
    customer_photo_url: str = Field(alias="customerPhotoUrl")
    order_id: str | None = Field(default=None, alias="orderId")
    size: str | None = None
    color: str | None = None


class CreatePaymentLinkBody(_Body):
    order_id: str = Field(alias="orderId")
    customer_id: str = Field(alias="customerId")
    amount: float
    currency: str
    idempotency_key: str = Field(alias="idempotencyKey")
    description: str | None = None
    metadata: dict[str, Any] | None = None


class NotFound(LookupError):
    """A row the request named does not exist. Distinct from a peer failure."""


# ── the bridge ────────────────────────────────────────────────────────────────


class Bridge:
    """Holds the collaborators the three routes share.

    A class rather than closures so tests can drive one handler with a fake Supabase
    client and a fake peer client, without standing up an ASGI app.
    """

    def __init__(
        self,
        *,
        supabase: Any,
        peers: PeerClient,
        preview_timeout_seconds: float = 90.0,
        preview_poll_interval_seconds: float = 2.0,
    ) -> None:
        self._supabase = supabase
        self._peers = peers
        self._preview_timeout = preview_timeout_seconds
        self._poll_interval = preview_poll_interval_seconds

    # ── Module 4: risk ────────────────────────────────────────

    async def score_risk(self, body: RiskScoreBody) -> dict[str, Any]:
        assessment = await asyncio.to_thread(
            score_customer, self._supabase, body.customer_id, body.zone
        )
        logger.info(
            "risk score for customer %s: %d (%s)",
            body.customer_id,
            assessment.score,
            assessment.factors,
        )
        return assessment.as_response()

    # ── Module 3: fitting ─────────────────────────────────────

    async def generate_preview(self, body: GeneratePreviewBody) -> dict[str, Any]:
        product = await asyncio.to_thread(self._fetch_product, body.product_id)
        if not product:
            raise NotFound(f"No product {body.product_id!r}")

        started = time.monotonic()
        request_id = _request_id(body)

        first = await self._peers.call(
            FITTING_PEER,
            "generate_preview",
            {
                "request_id": request_id,
                # The Fitting Agent requires an order_id. A preview can legitimately be
                # requested before an order exists (that is the point — see it, then
                # commit), so anchor those on the customer instead of inventing an id.
                "order_id": body.order_id or f"preview-only:{body.customer_id}",
                "customer_photo_url": body.customer_photo_url,
                "product": _product_ref(product, size=body.size, color=body.color),
            },
        )

        result = await self._await_render(first)
        preview_url = result.get("preview_image_url")
        if not preview_url:
            raise PeerError(
                FITTING_PEER,
                "get_preview",
                "no_image",
                "render reported ready without a preview_image_url",
            )

        response: dict[str, Any] = {
            "previewPhotoUrl": preview_url,
            "originalPhotoUrl": body.customer_photo_url,
            "latencyMs": round((time.monotonic() - started) * 1000),
        }
        # Extra signal the backend's contract marks optional but the pitch cares about:
        # whether that render happened live, and how well the item read on this customer.
        match = result.get("match")
        if isinstance(match, dict):
            response["match"] = match
        if "from_cache" in result:
            response["fromCache"] = bool(result["from_cache"])
        return response

    async def _await_render(self, first: dict[str, Any]) -> dict[str, Any]:
        """Poll ``get_preview`` until the render settles.

        ``generate_preview`` answers immediately with ``processing`` because a render
        takes 10-30s. The backend awaits a single call, so the wait happens here — and is
        bounded, so a wedged renderer becomes a 504 rather than a hung request.
        """
        result = first
        deadline = time.monotonic() + self._preview_timeout

        while _status(result) == "processing":
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"render did not finish within {self._preview_timeout:.0f}s "
                    f"(preview_id={result.get('preview_id')})"
                )
            await asyncio.sleep(self._poll_interval)
            preview_id = result.get("preview_id")
            if not preview_id:
                raise PeerError(
                    FITTING_PEER,
                    "generate_preview",
                    "malformed_response",
                    "status was processing but no preview_id was returned to poll",
                )
            result = await self._peers.call(
                FITTING_PEER, "get_preview", {"preview_id": preview_id}
            )

        if _status(result) == "failed":
            raise PeerError(
                FITTING_PEER,
                "get_preview",
                "render_failed",
                str(result.get("failure_reason") or "renderer gave no reason"),
            )
        return result

    # ── Module 5: payment ─────────────────────────────────────

    async def create_payment_link(self, body: CreatePaymentLinkBody) -> dict[str, Any]:
        if body.amount < 0:
            raise ValueError("amount must not be negative")

        order = await asyncio.to_thread(self._fetch_order, body.order_id)
        if not order:
            raise NotFound(f"No order {body.order_id!r}")
        customer = await asyncio.to_thread(self._fetch_customer, body.customer_id)
        if not customer:
            raise NotFound(f"No customer {body.customer_id!r}")

        currency = (body.currency or order.get("currency") or "TND").upper()
        output = await self._peers.call(
            PAYMENT_PEER,
            "collect_deposit",
            {
                "order_id": body.order_id,
                "seller_id": str(order.get("seller_id") or ""),
                "customer": {
                    "customer_id": body.customer_id,
                    # `name` is nullable in Postgres but the Payment Agent requires a
                    # string. A placeholder is honest here; a 400 would block a real order.
                    "full_name": customer.get("name") or "Unknown customer",
                    "phone": customer.get("phone") or "",
                    "email": None,
                    "zone": customer.get("zone"),
                },
                "order_total": {
                    "amount": _money(order.get("total_price")),
                    "currency": currency,
                },
                "deposit": {"amount": _money(body.amount), "currency": currency},
                "deposit_rate": _as_float(order.get("deposit_rate")),
                "risk_score": int(_as_float(order.get("risk_score"))),
                "channel": str(order.get("channel") or "whatsapp").lower(),
            },
        )

        return {
            "paymentId": output.get("payment_id"),
            # Null when status is not_required — a zero deposit never touches Gravv.
            "paymentUrl": output.get("checkout_url"),
            "expiresAt": output.get("expires_at"),
            "status": output.get("status"),
            "gravv": output.get("gravv"),
        }

    # ── Supabase reads ────────────────────────────────────────

    def _fetch_product(self, product_id: str) -> dict[str, Any]:
        return self._one("products", "id,sku,title,image_url,category,sizes,colors", product_id)

    def _fetch_order(self, order_id: str) -> dict[str, Any]:
        return self._one(
            "orders",
            "id,seller_id,customer_id,channel,total_price,currency,risk_score,deposit_rate",
            order_id,
        )

    def _fetch_customer(self, customer_id: str) -> dict[str, Any]:
        return self._one("customers", "id,name,phone,zone", customer_id)

    def _one(self, table: str, columns: str, row_id: str) -> dict[str, Any]:
        rows = (
            self._supabase.table(table).select(columns).eq("id", row_id).limit(1).execute().data
        )
        return rows[0] if rows else {}


# ── helpers ───────────────────────────────────────────────────────────────────


def _status(result: dict[str, Any]) -> str:
    return str(result.get("status") or "")


def _request_id(body: GeneratePreviewBody) -> str:
    """Stable idempotency anchor for a render.

    The Fitting Agent is idempotent on ``request_id``, and the backend retries on 5xx —
    so the same request must produce the same id, or a retry pays for a second render.
    Derived from everything that changes the image, and nothing that does not.
    """
    material = "|".join(
        [
            body.order_id or "",
            body.customer_id,
            body.product_id,
            body.customer_photo_url,
            body.size or "",
            body.color or "",
        ]
    )
    return f"req_{hashlib.sha256(material.encode('utf-8')).hexdigest()[:24]}"


def _product_ref(product: dict[str, Any], *, size: str | None, color: str | None) -> dict[str, Any]:
    """Turn a ``products`` row into the Fitting Agent's ``ProductRef``.

    Column names differ (``title`` here, ``name`` there) and ``sizes``/``colors`` are
    Postgres arrays, so the requested variant is chosen here, falling back to the first
    catalogued option rather than sending null and letting the renderer guess.
    """
    return {
        "sku": product.get("sku") or "",
        "name": product.get("title") or product.get("sku") or "Catalog item",
        "image_url": product.get("image_url") or "",
        "category": product.get("category") or "clothing",
        "color": color or _first(product.get("colors")),
        "size": size or _first(product.get("sizes")),
    }


def _first(value: Any) -> str | None:
    if isinstance(value, (list, tuple)) and value:
        return str(value[0])
    return None


def _money(value: Any, places: int = MONEY_PLACES) -> str:
    """Format an amount as the decimal *string* the peers require: ``"29.800"``.

    Never a float. TND's third decimal place is a real unit of money and JSON numbers
    lose it — this is the single most expensive rounding bug available in this codebase.
    """
    try:
        amount = Decimal(str(value if value is not None else 0))
    except InvalidOperation:
        amount = Decimal(0)
    if amount < 0:
        amount = Decimal(0)
    quantum = Decimal(1).scaleb(-places)
    return str(amount.quantize(quantum, rounding=ROUND_HALF_UP))


def _as_float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


# ── routing ───────────────────────────────────────────────────────────────────


def _handler(bridge: Bridge, model: type[_Body], method_name: str):
    """Wrap one bridge method as a Starlette endpoint with uniform error mapping.

    The status codes matter: the backend retries 5xx/408/429 and gives up immediately on
    other 4xx (``orchestrator.service.ts``). A bad product id must not be retried three
    times, and a peer that is merely down must be.
    """

    async def endpoint(request: Request) -> JSONResponse:
        try:
            payload = await request.json()
        except ValueError:
            return _error(400, "invalid_json", "Request body was not valid JSON.")
        if not isinstance(payload, dict):
            return _error(400, "invalid_json", "Request body must be a JSON object.")

        try:
            body = model.model_validate(payload)
        except ValidationError as exc:
            return _error(400, "invalid_input", exc.json())

        try:
            result = await getattr(bridge, method_name)(body)
        except NotFound as exc:
            return _error(404, "not_found", str(exc))
        except CustomerNotFound as exc:
            return _error(404, "not_found", f"No customer {exc.args[0]!r}")
        except ValueError as exc:
            return _error(400, "invalid_input", str(exc))
        except PeerNotConfigured as exc:
            return _error(503, exc.error_type, exc.message)
        except TimeoutError as exc:
            return _error(504, "timeout", str(exc))
        except PeerError as exc:
            # The peer's own validation failure is our bug, not a transient one — do not
            # invite three retries of a request that cannot succeed.
            logger.warning("peer call failed: %s", exc)
            return _error(PEER_ERROR_STATUS.get(exc.error_type, 502), exc.error_type, exc.message)
        except Exception as exc:
            logger.exception("%s failed", method_name)
            return _error(500, type(exc).__name__, str(exc))

        return JSONResponse(result)

    return endpoint


def _error(status: int, error_type: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"type": error_type, "message": message}}, status_code=status)


def bridge_routes(bridge: Bridge) -> list[Route]:
    """The three paths ``orchestrator.service.ts`` already calls. Keep them in step."""
    return [
        Route(
            "/agent/risk/score",
            _handler(bridge, RiskScoreBody, "score_risk"),
            methods=["POST"],
        ),
        Route(
            "/agent/fitting/generate-preview",
            _handler(bridge, GeneratePreviewBody, "generate_preview"),
            methods=["POST"],
        ),
        Route(
            "/agent/payment/create-link",
            _handler(bridge, CreatePaymentLinkBody, "create_payment_link"),
            methods=["POST"],
        ),
    ]


__all__ = [
    "Bridge",
    "CreatePaymentLinkBody",
    "GeneratePreviewBody",
    "NotFound",
    "RiskScoreBody",
    "bridge_routes",
]
