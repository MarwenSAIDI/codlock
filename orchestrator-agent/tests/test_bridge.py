"""The REST surface the NestJS backend calls.

Driven through the real Starlette app, with fakes only at the two edges the orchestrator
does not own (Supabase and the peer agents). What these tests are really defending is the
*seam*: the backend sends camelCase and JSON numbers, the peers demand snake_case and
decimal strings, and nothing in either project's own test suite can catch a mismatch.
"""

from __future__ import annotations

import httpx
import pytest
from httpx import ASGITransport

from codlock_agents.orchestrator.bridge import (
    Bridge,
    CreatePaymentLinkBody,
    GeneratePreviewBody,
)
from codlock_agents.orchestrator.peers import PeerError, PeerNotConfigured
from codlock_agents.orchestrator.server import create_app
from codlock_agents.orchestrator.settings import Settings

# ── fakes ─────────────────────────────────────────────────────────────────────

CUSTOMER = {
    "id": "cust_1",
    "name": "Amina B.",
    "phone": "+21620123456",
    "zone": "Ariana",
    "total_orders": 10,
    "successful_orders": 8,
    "refused_orders": 2,
}

PRODUCT = {
    "id": "prod_1",
    "sku": "DRESS-BEIGE-001",
    "title": "Beige Summer Dress",
    "image_url": "https://cdn.test/dress.jpg",
    "category": "dress",
    "sizes": ["S", "M", "L"],
    "colors": ["beige", "black"],
}

ORDER = {
    "id": "ord_1",
    "seller_id": "seller_1",
    "customer_id": "cust_1",
    "channel": "WHATSAPP",
    "total_price": 149,
    "currency": "TND",
    "risk_score": 72,
    "deposit_rate": 0.2,
    "status": "DEPOSIT_PENDING",
}


class FakeQuery:
    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows
        self._filters: list[tuple[str, object]] = []

    def eq(self, column: str, value: object) -> FakeQuery:
        self._filters.append((column, value))
        return self

    def limit(self, _n: int) -> FakeQuery:
        return self

    def execute(self):
        rows = [
            row
            for row in self._rows
            if all(row.get(col) == val for col, val in self._filters)
        ]
        return type("Result", (), {"data": rows})()


class FakeSupabase:
    """Only the reads the bridge performs. Unknown tables answer empty, not crash."""

    def __init__(self, tables: dict[str, list[dict]] | None = None) -> None:
        self.tables = tables if tables is not None else {
            "customers": [CUSTOMER],
            "products": [PRODUCT],
            "orders": [ORDER],
        }

    def table(self, name: str):
        rows = self.tables.get(name, [])
        return type("FakeTable", (), {"select": lambda _self, *a, **k: FakeQuery(rows)})()


class FakePeers:
    """Records every A2A call and replays scripted outputs per skill."""

    def __init__(self, outputs: dict[str, object] | None = None) -> None:
        self.outputs = outputs or {}
        self.calls: list[tuple[str, str, dict]] = []

    def has(self, _peer: str) -> bool:
        return True

    @property
    def names(self) -> list[str]:
        return ["fitting", "payment"]

    async def call(self, peer: str, skill: str, payload: dict) -> dict:
        self.calls.append((peer, skill, payload))
        scripted = self.outputs.get(skill)
        if isinstance(scripted, Exception):
            raise scripted
        if callable(scripted):
            return scripted(len([c for c in self.calls if c[1] == skill]))
        return scripted or {}

    def payload_for(self, skill: str) -> dict:
        return next(payload for _p, s, payload in self.calls if s == skill)


def make_bridge(*, supabase=None, peers=None, **kwargs) -> Bridge:
    return Bridge(
        supabase=supabase or FakeSupabase(),
        peers=peers or FakePeers(),
        preview_poll_interval_seconds=kwargs.pop("poll", 0.0),
        **kwargs,
    )


def stub_settings(**overrides) -> Settings:
    defaults = {
        "model_name": "openai/gpt-4o",
        "model_api_url": "https://example.test/v1",
        "model_api_key": "test-key",
        "supabase_url": "https://example.test",
        "supabase_key": "test-service-key",
        "a2a_agents": "payment=http://localhost:8001,fitting=http://localhost:8002",
    }
    return Settings(_env_file=None, **{**defaults, **overrides})  # type: ignore[call-arg]


# ── the routes exist at all ───────────────────────────────────────────────────
# This is the regression that mattered: the backend calls three fixed paths and the
# ADK app served none of them, so every AI call 404'd behind a circuit breaker.


@pytest.fixture
async def client():
    app = create_app(stub_settings(), supabase=FakeSupabase())
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://orchestrator") as c:
            yield c


async def test_the_backends_three_paths_are_all_served(client):
    """Whatever these answer, none of them may 404 — that was the original break."""
    for path, body in [
        ("/agent/risk/score", {"customerId": "cust_1"}),
        (
            "/agent/fitting/generate-preview",
            {"customerId": "cust_1", "productId": "prod_1", "customerPhotoUrl": "https://x/p.jpg"},
        ),
        (
            "/agent/payment/create-link",
            {
                "orderId": "ord_1",
                "customerId": "cust_1",
                "amount": 29.8,
                "currency": "TND",
                "idempotencyKey": "deposit:ord_1",
            },
        ),
    ]:
        response = await client.post(path, json=body)
        assert response.status_code != 404, f"{path} is not routed"


async def test_health_advertises_the_bridge_routes(client):
    health = (await client.get("/health")).json()
    assert set(health["bridge"]) == {
        "/agent/risk/score",
        "/agent/fitting/generate-preview",
        "/agent/payment/create-link",
    }


# ── risk ──────────────────────────────────────────────────────────────────────


async def test_risk_score_returns_the_backends_contract(client):
    response = await client.post("/agent/risk/score", json={"customerId": "cust_1"})
    assert response.status_code == 200
    body = response.json()
    # 2 refusals in 10 orders = 20, plus the same zone rate weighted at 20 points.
    assert body["score"] == 24
    assert body["factors"]["firstTimeBuyer"] is False
    assert body["factors"]["completedOrders"] == 8


async def test_risk_score_for_an_unknown_customer_is_404_not_500(client):
    """A 4xx stops the backend retrying; a 500 would burn three attempts on a typo."""
    response = await client.post("/agent/risk/score", json={"customerId": "nope"})
    assert response.status_code == 404


async def test_risk_score_rejects_a_body_missing_the_customer(client):
    assert (await client.post("/agent/risk/score", json={"zone": "Ariana"})).status_code == 400


async def test_first_time_buyer_scores_the_same_as_the_backends_fallback():
    """65 in both places, so an orchestrator outage does not move the deposit."""
    fresh = {**CUSTOMER, "id": "cust_new", "total_orders": 0, "refused_orders": 0,
             "successful_orders": 0, "zone": None}
    bridge = make_bridge(supabase=FakeSupabase({"customers": [fresh]}))
    from codlock_agents.orchestrator.bridge import RiskScoreBody

    result = await bridge.score_risk(RiskScoreBody(customerId="cust_new"))
    assert result["score"] == 65
    assert result["factors"]["firstTimeBuyer"] is True


# ── fitting ───────────────────────────────────────────────────────────────────


def ready(**overrides) -> dict:
    return {
        "preview_id": "prev_1",
        "request_id": "req_x",
        "status": "ready",
        "preview_image_url": "https://cdn.test/preview.png",
        "match": {"quality": 0.9, "verdict": "good_match", "reason": "ok",
                  "recommend_alternative": False},
        "from_cache": False,
        **overrides,
    }


async def test_generate_preview_sends_a_full_product_ref_not_an_id():
    """The backend has only a product id; the Fitting Agent needs sku/name/image."""
    peers = FakePeers({"generate_preview": ready()})
    bridge = make_bridge(peers=peers)
    result = await bridge.generate_preview(
        GeneratePreviewBody(
            customerId="cust_1",
            productId="prod_1",
            customerPhotoUrl="https://x/p.jpg",
            size="M",
        )
    )

    product = peers.payload_for("generate_preview")["product"]
    assert product["sku"] == "DRESS-BEIGE-001"
    assert product["name"] == "Beige Summer Dress"  # `title` in Postgres, `name` in the peer
    assert product["size"] == "M"
    assert product["color"] == "beige"  # first catalogued colour, not null
    assert result["previewPhotoUrl"] == "https://cdn.test/preview.png"
    assert result["originalPhotoUrl"] == "https://x/p.jpg"


async def test_generate_preview_polls_until_the_render_is_ready():
    """generate_preview answers 'processing'; the backend awaits one call, so we poll."""
    peers = FakePeers(
        {
            "generate_preview": {"preview_id": "prev_1", "request_id": "r", "status": "processing"},
            "get_preview": lambda n: (
                {"preview_id": "prev_1", "request_id": "r", "status": "processing"}
                if n < 2
                else ready()
            ),
        }
    )
    bridge = make_bridge(peers=peers)
    result = await bridge.generate_preview(
        GeneratePreviewBody(
            customerId="cust_1", productId="prod_1", customerPhotoUrl="https://x/p.jpg"
        )
    )
    assert result["previewPhotoUrl"] == "https://cdn.test/preview.png"
    assert len([c for c in peers.calls if c[1] == "get_preview"]) == 2


async def test_a_render_that_never_finishes_times_out_rather_than_hanging():
    peers = FakePeers(
        {
            "generate_preview": {"preview_id": "prev_1", "request_id": "r", "status": "processing"},
            "get_preview": {"preview_id": "prev_1", "request_id": "r", "status": "processing"},
        }
    )
    bridge = make_bridge(peers=peers, preview_timeout_seconds=0.05, poll=0.01)
    with pytest.raises(TimeoutError):
        await bridge.generate_preview(
            GeneratePreviewBody(
                customerId="cust_1", productId="prod_1", customerPhotoUrl="https://x/p.jpg"
            )
        )


async def test_a_failed_render_surfaces_the_renderers_reason():
    peers = FakePeers(
        {"generate_preview": {"preview_id": "p", "request_id": "r", "status": "failed",
                              "failure_reason": "safety filter blocked the photo"}}
    )
    bridge = make_bridge(peers=peers)
    with pytest.raises(PeerError, match="safety filter"):
        await bridge.generate_preview(
            GeneratePreviewBody(
                customerId="cust_1", productId="prod_1", customerPhotoUrl="https://x/p.jpg"
            )
        )


async def test_the_render_request_id_is_stable_so_a_retry_is_free():
    peers = FakePeers({"generate_preview": ready()})
    bridge = make_bridge(peers=peers)
    body = GeneratePreviewBody(
        customerId="cust_1", productId="prod_1", customerPhotoUrl="https://x/p.jpg", size="M"
    )
    await bridge.generate_preview(body)
    await bridge.generate_preview(body)
    ids = {payload["request_id"] for _p, s, payload in peers.calls if s == "generate_preview"}
    assert len(ids) == 1


async def test_an_unknown_product_is_404(client):
    response = await client.post(
        "/agent/fitting/generate-preview",
        json={"customerId": "cust_1", "productId": "ghost", "customerPhotoUrl": "https://x/p.jpg"},
    )
    assert response.status_code == 404


# ── payment ───────────────────────────────────────────────────────────────────


COLLECTED = {
    "payment_id": "pay_1",
    "order_id": "ord_1",
    "status": "awaiting_payment",
    "amount": {"amount": "29.800", "currency": "TND"},
    "checkout_url": "https://checkout.gravv.test/abc",
    "expires_at": "2026-08-09T20:00:00Z",
    "gravv": {"collection_id": "col_1", "environment": "sandbox"},
    "failure_reason": None,
}


def payment_body(**overrides) -> CreatePaymentLinkBody:
    fields = {
        "orderId": "ord_1",
        "customerId": "cust_1",
        "amount": 29.8,
        "currency": "TND",
        "idempotencyKey": "deposit:ord_1",
    }
    return CreatePaymentLinkBody(**{**fields, **overrides})


async def test_money_crosses_as_a_three_place_decimal_string():
    """TND is quoted in millimes and the peer's zod rejects a JSON number outright."""
    peers = FakePeers({"collect_deposit": COLLECTED})
    bridge = make_bridge(peers=peers)
    await bridge.create_payment_link(payment_body())

    sent = peers.payload_for("collect_deposit")
    assert sent["deposit"] == {"amount": "29.800", "currency": "TND"}
    assert sent["order_total"] == {"amount": "149.000", "currency": "TND"}
    assert isinstance(sent["deposit"]["amount"], str)


async def test_channel_is_lowercased_for_the_payment_agents_enum():
    """Postgres stores WHATSAPP; the Payment Agent's zod enum only accepts whatsapp."""
    peers = FakePeers({"collect_deposit": COLLECTED})
    await make_bridge(peers=peers).create_payment_link(payment_body())
    assert peers.payload_for("collect_deposit")["channel"] == "whatsapp"


async def test_the_customer_and_audit_fields_are_filled_from_supabase():
    peers = FakePeers({"collect_deposit": COLLECTED})
    await make_bridge(peers=peers).create_payment_link(payment_body())

    sent = peers.payload_for("collect_deposit")
    assert sent["seller_id"] == "seller_1"
    assert sent["customer"]["full_name"] == "Amina B."
    assert sent["customer"]["phone"] == "+21620123456"
    assert sent["risk_score"] == 72
    assert sent["deposit_rate"] == 0.2


async def test_a_nameless_customer_still_gets_a_link():
    """`name` is nullable in Postgres but required by the peer — placeholder, not a 400."""
    peers = FakePeers({"collect_deposit": COLLECTED})
    supabase = FakeSupabase(
        {"customers": [{**CUSTOMER, "name": None}], "orders": [ORDER], "products": [PRODUCT]}
    )
    await make_bridge(peers=peers, supabase=supabase).create_payment_link(payment_body())
    assert peers.payload_for("collect_deposit")["customer"]["full_name"] == "Unknown customer"


async def test_the_response_is_mapped_to_the_backends_camelcase_contract():
    bridge = make_bridge(peers=FakePeers({"collect_deposit": COLLECTED}))
    result = await bridge.create_payment_link(payment_body())
    assert result["paymentId"] == "pay_1"
    assert result["paymentUrl"] == "https://checkout.gravv.test/abc"
    assert result["expiresAt"] == "2026-08-09T20:00:00Z"
    assert result["status"] == "awaiting_payment"


async def test_a_zero_deposit_returns_a_null_url_not_an_error():
    """`not_required` is a legal outcome: no Gravv call, so there is no link."""
    output = {**COLLECTED, "status": "not_required", "checkout_url": None, "expires_at": None}
    bridge = make_bridge(peers=FakePeers({"collect_deposit": output}))
    result = await bridge.create_payment_link(payment_body(amount=0))
    assert result["status"] == "not_required"
    assert result["paymentUrl"] is None


async def test_an_unknown_order_is_404(client):
    response = await client.post(
        "/agent/payment/create-link",
        json={"orderId": "ghost", "customerId": "cust_1", "amount": 10,
              "currency": "TND", "idempotencyKey": "k"},
    )
    assert response.status_code == 404


# ── failure mapping ───────────────────────────────────────────────────────────
# The backend retries 5xx/408/429 and gives up on other 4xx, so which status a
# failure gets decides whether it is retried three times or once.


@pytest.mark.parametrize(
    "error,expected",
    [
        (PeerNotConfigured("payment", "collect_deposit", []), 503),
        (PeerError("payment", "collect_deposit", "unreachable", "connection refused"), 502),
        (PeerError("payment", "collect_deposit", "invalid_input", "bad phone"), 400),
    ],
)
async def test_peer_failures_map_onto_meaningful_statuses(error, expected):
    from starlette.applications import Starlette

    from codlock_agents.orchestrator.bridge import bridge_routes

    # A bare app carrying only these routes: mounting them onto the real one would put
    # them behind create_app's own copies, and the first match would answer instead.
    bridge = make_bridge(peers=FakePeers({"collect_deposit": error}))
    app = Starlette(routes=bridge_routes(bridge))

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://o") as c:
        response = await c.post(
            "/agent/payment/create-link",
            json={"orderId": "ord_1", "customerId": "cust_1", "amount": 5,
                  "currency": "TND", "idempotencyKey": "k"},
        )
    assert response.status_code == expected
