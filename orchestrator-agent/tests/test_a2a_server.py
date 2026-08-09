"""Drive the orchestrator's A2A surface, the way a peer agent or the backend will.

Through the ASGI app rather than the agent object directly, so what is actually proven
is the thing exposed on the wire: the agent card at the well-known path, built by
``google-adk``'s ``to_a2a`` straight from the agent definition.
"""

from __future__ import annotations

import httpx
import pytest
from httpx import ASGITransport

from codlock_agents.orchestrator.server import create_app
from codlock_agents.orchestrator.settings import Settings


def stub_settings(**overrides) -> Settings:
    defaults = {
        "model_name": "openai/gpt-4o",
        "model_api_url": "https://example.test/v1",
        "model_api_key": "test-key",
        "supabase_url": "https://example.test",
        "supabase_key": "test-service-key",
        "backend_base_url": "http://backend.test/api/v1",
        "backend_api_token": "test-backend-token",
        "a2a_agents": "",
    }
    return Settings(_env_file=None, **{**defaults, **overrides})  # type: ignore[call-arg]


async def make_client(settings: Settings):
    """Starlette builds its A2A routes inside its lifespan (the card is built
    asynchronously), so the lifespan has to be driven manually — ASGITransport
    does not trigger it on its own."""
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://orchestrator") as c:
            yield c


@pytest.fixture
async def client():
    async for c in make_client(stub_settings()):
        yield c


async def test_agent_card_is_served_at_the_well_known_path(client):
    response = await client.get("/.well-known/agent-card.json")
    assert response.status_code == 200
    card = response.json()
    assert card["name"] == "codlock_orchestrator"


async def test_agent_card_advertises_every_internal_tool(client):
    card = (await client.get("/.well-known/agent-card.json")).json()
    tool_names = {skill["name"] for skill in card["skills"]}
    assert {
        "risk_score_tool",
        "get_product_tool",
        "get_order_tool",
        "create_order_tool",
        "delete_order_tool",
    } <= tool_names


async def test_agent_card_advertises_configured_peers():
    async for c in make_client(stub_settings(a2a_agents="fitting=http://localhost:8002")):
        card = (await c.get("/.well-known/agent-card.json")).json()
    assert any(skill["tags"] and "sub_agent:fitting" in skill["tags"] for skill in card["skills"])


async def test_health_probe_lists_tools_and_peers():
    async for c in make_client(stub_settings(a2a_agents="fitting=http://localhost:8002")):
        health = (await c.get("/health")).json()
    assert health["status"] == "ok"
    assert health["agent"] == "codlock_orchestrator"
    assert "get_product_tool" in health["tools"]
    assert health["peers"] == ["fitting"]
