"""Drive the Fitting Agent over real A2A JSON-RPC, the way the orchestrator will.

Through the HTTP surface rather than calling the service directly, because the thing
most likely to break on Sunday is the wire, not the logic.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import httpx
import pytest
from httpx import ASGITransport

from codlock_agents.fitting.server import create_app
from codlock_agents.settings import Settings


def stub_settings(**overrides: Any) -> Settings:
    return Settings(stub_mode=True, gemini_api_key=None, _env_file=None, **overrides)  # type: ignore[call-arg]


async def send(client: httpx.AsyncClient, parts: list[dict]) -> dict:
    response = await client.post(
        "/",
        # Mandatory. Without it the server rejects the call as protocol 0.3.
        headers={"A2A-Version": "1.0"},
        json={
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "SendMessage",
            "params": {
                "message": {
                    "messageId": str(uuid.uuid4()),
                    "role": "ROLE_USER",
                    "parts": parts,
                }
            },
        },
    )
    response.raise_for_status()
    body = response.json()
    assert "error" not in body, body
    return body["result"]["message"]["parts"][0]["data"]


async def call(client: httpx.AsyncClient, skill: str, payload: dict) -> dict:
    """One A2A skill call. Mirrors exactly what the orchestrator has to send."""
    return await send(client, [{"data": {"skill": skill, "input": payload}}])


async def call_text(client: httpx.AsyncClient, text: str) -> dict:
    """A plain-text delegation, the way google-adk's RemoteA2aAgent sends one."""
    return await send(client, [{"text": text}])


@pytest.fixture
async def client():
    app = create_app(stub_settings())
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://fitting") as c:
        yield c


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


async def poll_until_done(client: httpx.AsyncClient, preview_id: str) -> dict:
    for _ in range(40):
        latest = (await call(client, "get_preview", {"preview_id": preview_id}))["output"]
        if latest["status"] != "processing":
            return latest
        await asyncio.sleep(0.25)
    raise AssertionError("preview never left processing")


# --------------------------------------------------------------------------------------
# discovery
# --------------------------------------------------------------------------------------


async def test_agent_card_advertises_its_skills(client):
    card = (await client.get("/.well-known/agent-card.json")).json()
    assert card["name"] == "CODLOCK Fitting Agent"
    assert {s["id"] for s in card["skills"]} == {"generate_preview", "get_preview"}


async def test_health_probe(client):
    health = (await client.get("/health")).json()
    assert health["status"] == "ok"


# --------------------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------------------


async def test_preview_starts_processing_then_becomes_ready(client):
    started = (await call(client, "generate_preview", PREVIEW))["output"]
    assert started["status"] == "processing"
    assert started["preview_image_url"] is None

    latest = await poll_until_done(client, started["preview_id"])
    assert latest["status"] == "ready", latest
    assert latest["preview_image_url"]
    assert latest["match"]["verdict"] == "good_match"
    # A demo must never silently pretend a fixture was a live render.
    assert latest["from_cache"] is True


async def test_generate_preview_is_idempotent_on_request_id(client):
    first = (await call(client, "generate_preview", PREVIEW))["output"]
    second = (await call(client, "generate_preview", PREVIEW))["output"]
    assert first["preview_id"] == second["preview_id"]


async def test_polling_an_unknown_preview_fails_cleanly(client):
    output = (await call(client, "get_preview", {"preview_id": "prv_nope"}))["output"]
    assert output["status"] == "failed"
    assert "prv_nope" in output["failure_reason"]


# --------------------------------------------------------------------------------------
# errors are structured, never crashes
# --------------------------------------------------------------------------------------


async def test_invalid_input_is_a_structured_error(client):
    bad = await call(client, "generate_preview", {"request_id": "req_x"})
    assert bad["ok"] is False
    assert bad["error"]["type"] == "invalid_input"


async def test_unknown_skill_lists_what_is_available(client):
    bad = await call(client, "does_not_exist", {})
    assert bad["ok"] is False
    assert "generate_preview" in bad["error"]["message"]


# --------------------------------------------------------------------------------------
# natural-language delegation (google-adk RemoteA2aAgent)
# --------------------------------------------------------------------------------------


async def test_json_envelope_in_a_text_part_needs_no_model(client):
    import json

    result = await call_text(
        client, json.dumps({"skill": "generate_preview",
                            "input": {**PREVIEW, "request_id": "req_text_json"}})
    )
    assert result["ok"] is True, result
    assert result["output"]["status"] == "processing"


async def test_free_text_without_an_extractor_refuses_rather_than_guesses(client):
    result = await call_text(client, "Show me that dress on the customer please.")
    assert result["ok"] is False
    assert result["error"]["type"] == "extraction_failed"
    assert "GEMINI_API_KEY" in result["error"]["message"]


def app_with_extractor(extractor) -> Any:
    """Build the same app the server builds, but with a stand-in extractor."""
    from codlock_agents.fitting.server import SKILLS, build_router
    from codlock_agents.serving import build_app, build_card

    card = build_card(
        name="CODLOCK Fitting Agent", description="", url="http://test/", skills=SKILLS
    )
    return build_app(card, build_router(stub_settings()), extractor)


async def test_free_text_is_extracted_then_run_like_any_other_call():
    """The model only transcribes. The handler it reaches is the ordinary one."""

    class FakeExtractor:
        async def extract(self, text: str):
            return "generate_preview", {**PREVIEW, "request_id": "req_from_text"}

    transport = ASGITransport(app=app_with_extractor(FakeExtractor()))
    async with httpx.AsyncClient(transport=transport, base_url="http://fitting") as c:
        result = await call_text(c, "Please try the beige summer dress on her.")
        assert result["ok"] is True, result
        assert result["output"]["request_id"] == "req_from_text"


async def test_hallucinated_extraction_is_rejected_by_validation():
    """If the model invents a shape, validation stops it before any render happens."""

    class HallucinatingExtractor:
        async def extract(self, text: str):
            return "generate_preview", {"request_id": "req_bad", "nonsense": True}

    transport = ASGITransport(app=app_with_extractor(HallucinatingExtractor()))
    async with httpx.AsyncClient(transport=transport, base_url="http://fitting") as c:
        result = await call_text(c, "do something vague")
        assert result["ok"] is False
        assert result["error"]["type"] == "invalid_input"


async def test_a_dead_extractor_is_a_structured_error_not_a_crash():
    class BrokenExtractor:
        async def extract(self, text: str):
            raise RuntimeError("Gemini returned 503")

    transport = ASGITransport(app=app_with_extractor(BrokenExtractor()))
    async with httpx.AsyncClient(transport=transport, base_url="http://fitting") as c:
        result = await call_text(c, "try the dress on her")
        assert result["ok"] is False
        assert result["error"]["type"] == "extraction_failed"
        assert "503" in result["error"]["message"]
