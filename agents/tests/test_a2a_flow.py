"""Drive both agents over real A2A JSON-RPC, the way the orchestrator will.

These go through the actual HTTP surface rather than calling the services directly,
because the thing most likely to break on Sunday is the wire, not the arithmetic.
"""

from __future__ import annotations

import asyncio
import uuid

import httpx
import pytest
from httpx import ASGITransport

from codlock_agents.fitting.server import create_app as create_fitting_app
from codlock_agents.payment.server import create_app as create_payment_app
from codlock_agents.settings import Settings


def stub_settings() -> Settings:
    return Settings(stub_mode=True, _env_file=None)  # type: ignore[call-arg]


async def call(client: httpx.AsyncClient, skill: str, payload: dict) -> dict:
    """One A2A skill call. Mirrors exactly what the orchestrator has to send.

    The ``A2A-Version`` header is mandatory — without it the server rejects the call as
    protocol 0.3. This bites every new client exactly once, so it is asserted by the
    whole suite rather than documented and forgotten.
    """
    response = await client.post(
        "/",
        headers={"A2A-Version": "1.0"},
        json={
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "SendMessage",
            "params": {
                "message": {
                    "messageId": str(uuid.uuid4()),
                    "role": "ROLE_USER",
                    "parts": [{"data": {"skill": skill, "input": payload}}],
                }
            },
        },
    )
    response.raise_for_status()
    body = response.json()
    assert "error" not in body, body
    parts = body["result"]["message"]["parts"]
    return parts[0]["data"]


@pytest.fixture
async def payment_client():
    app = create_payment_app(stub_settings())
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://payment") as c:
        yield c


@pytest.fixture
async def fitting_client():
    app = create_fitting_app(stub_settings())
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://fitting") as c:
        yield c


ORDER = {
    "order_id": "ord_demo_1",
    "seller_id": "S456",
    "customer": {
        "customer_id": "C123",
        "full_name": "Amira Ben Salah",
        "phone": "+21620123456",
        "zone": "Ariana",
    },
    "order_total": {"amount": "149.000", "currency": "TND"},
    "deposit": {"amount": "29.800", "currency": "TND"},
    "deposit_rate": 0.2,
    "risk_score": 32,
    "channel": "instagram",
}


# --------------------------------------------------------------------------------------
# discovery
# --------------------------------------------------------------------------------------


async def test_payment_agent_card_advertises_its_skills(payment_client):
    card = (await payment_client.get("/.well-known/agent-card.json")).json()
    assert card["name"] == "CODLOCK Payment Agent"
    assert {s["id"] for s in card["skills"]} == {
        "collect_deposit",
        "confirm_payment",
        "settle_order",
    }


async def test_fitting_agent_card_advertises_its_skills(fitting_client):
    card = (await fitting_client.get("/.well-known/agent-card.json")).json()
    assert {s["id"] for s in card["skills"]} == {"generate_preview", "get_preview"}


# --------------------------------------------------------------------------------------
# payment
# --------------------------------------------------------------------------------------


async def test_deposit_flow_from_checkout_to_settlement(payment_client):
    opened = await call(payment_client, "collect_deposit", ORDER)
    assert opened["ok"] is True, opened
    deposit = opened["output"]
    assert deposit["status"] == "awaiting_payment"
    assert deposit["checkout_url"]

    confirm_args = {
        "payment_id": deposit["payment_id"],
        "order_id": deposit["order_id"],
    }

    first = (await call(payment_client, "confirm_payment", confirm_args))["output"]
    assert first["status"] == "awaiting_payment"

    # The stub clears on the second poll, so the orchestrator must actually poll.
    for _ in range(5):
        latest = (await call(payment_client, "confirm_payment", confirm_args))["output"]
        if latest["status"] == "paid":
            break
    assert latest["status"] == "paid"
    assert latest["paid"]["amount"] == "29.800"

    settled = (
        await call(
            payment_client,
            "settle_order",
            {**confirm_args, "outcome": "refused",
             "courier_fee": {"amount": "8.000", "currency": "TND"}},
        )
    )["output"]
    assert settled["disposition"] == "retained_for_courier"
    assert settled["seller_shortfall"]["amount"] == "0"


async def test_zero_deposit_never_touches_gravv(payment_client):
    payload = {**ORDER, "order_id": "ord_clean_customer",
               "deposit": {"amount": "0", "currency": "TND"},
               "deposit_rate": 0.0, "risk_score": 4}
    output = (await call(payment_client, "collect_deposit", payload))["output"]
    assert output["status"] == "not_required"
    assert output["checkout_url"] is None


async def test_collect_deposit_is_idempotent_on_order_id(payment_client):
    payload = {**ORDER, "order_id": "ord_retry"}
    first = (await call(payment_client, "collect_deposit", payload))["output"]
    second = (await call(payment_client, "collect_deposit", payload))["output"]
    assert first["payment_id"] == second["payment_id"]
    assert first["checkout_url"] == second["checkout_url"]


async def test_invalid_input_is_a_structured_error_not_a_crash(payment_client):
    bad = await call(payment_client, "collect_deposit", {"order_id": "ord_x"})
    assert bad["ok"] is False
    assert bad["error"]["type"] == "invalid_input"


async def test_unknown_skill_lists_what_is_available(payment_client):
    bad = await call(payment_client, "does_not_exist", {})
    assert bad["ok"] is False
    assert "collect_deposit" in bad["error"]["message"]


async def test_settling_an_unknown_order_fails_loudly(payment_client):
    bad = await call(
        payment_client,
        "settle_order",
        {"order_id": "ord_never_seen", "payment_id": "pay_nope",
         "outcome": "accepted"},
    )
    assert bad["ok"] is False
    assert bad["error"]["type"] == "LookupError"


# --------------------------------------------------------------------------------------
# fitting
# --------------------------------------------------------------------------------------


PREVIEW = {
    "request_id": "req_demo_1",
    "order_id": "ord_demo_1",
    "customer_photo_url": "https://example.test/customer.jpg",
    "product": {
        "sku": "DRESS-BEIGE-001",
        "name": "Beige Summer Dress",
        "image_url": "https://example.test/dress.jpg",
        "category": "dress",
        "color": "beige",
        "size": "M",
    },
}


async def test_preview_starts_processing_then_becomes_ready(fitting_client):
    started = (await call(fitting_client, "generate_preview", PREVIEW))["output"]
    assert started["status"] == "processing"
    assert started["preview_image_url"] is None

    for _ in range(40):
        latest = (
            await call(fitting_client, "get_preview",
                       {"preview_id": started["preview_id"]})
        )["output"]
        if latest["status"] != "processing":
            break
        await asyncio.sleep(0.25)

    assert latest["status"] == "ready", latest
    assert latest["preview_image_url"]
    assert latest["match"]["verdict"] == "good_match"
    # A demo must never silently pretend a fixture was a live render.
    assert latest["from_cache"] is True


async def test_generate_preview_is_idempotent_on_request_id(fitting_client):
    first = (await call(fitting_client, "generate_preview", PREVIEW))["output"]
    second = (await call(fitting_client, "generate_preview", PREVIEW))["output"]
    assert first["preview_id"] == second["preview_id"]


async def test_polling_an_unknown_preview_fails_cleanly(fitting_client):
    output = (
        await call(fitting_client, "get_preview", {"preview_id": "prv_nope"})
    )["output"]
    assert output["status"] == "failed"
    assert "prv_nope" in output["failure_reason"]
