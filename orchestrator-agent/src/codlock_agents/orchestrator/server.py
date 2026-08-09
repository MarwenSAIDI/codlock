"""Orchestrator Agent: A2A server wrapping the root ADK agent.

``google.adk``'s ``to_a2a`` builds the agent card and JSON-RPC routes straight
from the agent definition, so this module only wires settings to the agent
and serves the resulting app — the same split fitting-agent draws between
``server.py`` (what the agent does) and ``serving.py`` (how it is served).
"""

from __future__ import annotations

import logging

import uvicorn
from google.adk.a2a.utils.agent_to_a2a import to_a2a
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse

from codlock_agents.orchestrator.agent import build_agent, build_supabase_client
from codlock_agents.orchestrator.bridge import Bridge, bridge_routes
from codlock_agents.orchestrator.peers import PeerClient, parse_peer_map
from codlock_agents.orchestrator.settings import Settings, get_settings

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None, *, supabase: object | None = None) -> Starlette:
    """Serve two surfaces over one port.

    ``to_a2a`` gives the agent surface: JSON-RPC at ``/`` and the card at the well-known
    path, which is what a peer agent talks to. Bolted alongside it are ``/health`` and
    the ``/agent/*`` REST routes the NestJS backend calls — see
    :mod:`codlock_agents.orchestrator.bridge` for why the backend does not speak A2A
    directly.
    """
    settings = settings or get_settings()
    client = supabase if supabase is not None else build_supabase_client(settings)
    agent = build_agent(settings, supabase=client)
    app = to_a2a(
        agent,
        host=settings.orchestrator_host,
        port=settings.orchestrator_port,
    )

    peers = PeerClient(
        parse_peer_map(settings.a2a_agents),
        timeout_seconds=settings.peer_call_timeout_seconds,
    )
    bridge = Bridge(
        supabase=client,
        peers=peers,
        preview_timeout_seconds=settings.preview_timeout_seconds,
        preview_poll_interval_seconds=settings.preview_poll_interval_seconds,
    )

    async def health(_request: Request) -> JSONResponse:
        """Cheap liveness probe for whoever deploys this on Sunday.

        The backend polls this through the same circuit breaker it uses for real calls,
        so it also reports the bridge routes — a green health check that hides a missing
        route is worse than no health check.
        """
        return JSONResponse(
            {
                "status": "ok",
                "agent": agent.name,
                "tools": [tool.__name__ for tool in agent.tools],
                "peers": [peer.name for peer in agent.sub_agents],
                "bridge": [route.path for route in bridge_routes(bridge)],
            }
        )

    app.add_route("/health", health, methods=["GET"])
    for route in bridge_routes(bridge):
        app.add_route(route.path, route.endpoint, methods=["POST"])
    return app


def main() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
    )
    app = create_app(settings)
    logger.info(
        "codlock_orchestrator listening on http://%s:%d",
        settings.orchestrator_host,
        settings.orchestrator_port,
    )
    logger.info(
        "agent card at http://%s:%d/.well-known/agent-card.json",
        settings.orchestrator_host,
        settings.orchestrator_port,
    )
    uvicorn.run(
        app,
        host=settings.orchestrator_host,
        port=settings.orchestrator_port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
