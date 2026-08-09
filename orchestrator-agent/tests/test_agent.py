"""Root agent assembly: internal tools plus peers discovered over A2A.

Supabase and the remote peers are injected so this never needs a live
project or live services just to prove the wiring is correct.
"""

from __future__ import annotations

import pytest
from google.adk.agents.remote_a2a_agent import RemoteA2aAgent

from codlock_agents.orchestrator.agent import build_agent, parse_a2a_agents
from codlock_agents.orchestrator.settings import Settings


def settings(**overrides) -> Settings:
    defaults = {
        "model_name": "openai/gpt-4o",
        "model_api_url": "https://example.test/v1",
        "model_api_key": "test-key",
        "supabase_url": "https://example.test",
        "supabase_key": "test-service-key",
        "a2a_agents": "",
    }
    return Settings(_env_file=None, **{**defaults, **overrides})  # type: ignore[call-arg]


class FakeSupabase:
    def table(self, name: str):
        raise AssertionError("tools should not be called during agent assembly")


# --------------------------------------------------------------------------------------
# A2A_AGENTS parsing
# --------------------------------------------------------------------------------------


def test_parse_a2a_agents_builds_one_remote_agent_per_pair():
    agents = parse_a2a_agents(
        "payment=http://localhost:8001,fitting=http://localhost:8002"
    )
    assert [a.name for a in agents] == ["payment", "fitting"]


def test_parse_a2a_agents_ignores_blank_entries():
    assert parse_a2a_agents("") == []
    assert parse_a2a_agents(" , ,") == []


@pytest.mark.parametrize("bad", ["payment", "=http://localhost:8001", "payment="])
def test_parse_a2a_agents_rejects_malformed_entries(bad):
    with pytest.raises(RuntimeError, match="Invalid A2A_AGENTS entry"):
        parse_a2a_agents(bad)


# --------------------------------------------------------------------------------------
# root agent wiring
# --------------------------------------------------------------------------------------


def test_build_agent_registers_every_internal_tool():
    agent = build_agent(settings(), supabase=FakeSupabase(), remote_agents=[])
    assert agent.name == "codlock_orchestrator"
    assert [t.__name__ for t in agent.tools] == [
        "risk_score_tool",
        "get_product_tool",
        "get_order_tool",
        "create_order_tool",
        "delete_order_tool",
    ]


def test_build_agent_wires_in_the_given_remote_peers():
    peers = [RemoteA2aAgent(name="fitting", agent_card="http://localhost:8002")]
    agent = build_agent(settings(), supabase=FakeSupabase(), remote_agents=peers)
    assert agent.sub_agents == peers


def test_build_agent_parses_a2a_agents_from_settings_when_not_overridden():
    agent = build_agent(
        settings(a2a_agents="payment=http://localhost:8001"),
        supabase=FakeSupabase(),
    )
    assert [a.name for a in agent.sub_agents] == ["payment"]
