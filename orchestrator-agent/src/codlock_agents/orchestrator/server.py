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

from codlock_agents.orchestrator.agent import build_agent
from codlock_agents.orchestrator.settings import Settings, get_settings

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> Starlette:
    settings = settings or get_settings()
    agent = build_agent(settings)
    app = to_a2a(
        agent,
        host=settings.orchestrator_host,
        port=settings.orchestrator_port,
    )

    async def health(_request: Request) -> JSONResponse:
        """Cheap liveness probe for whoever deploys this on Sunday."""
        return JSONResponse(
            {
                "status": "ok",
                "agent": agent.name,
                "tools": [tool.__name__ for tool in agent.tools],
                "peers": [peer.name for peer in agent.sub_agents],
            }
        )

    app.add_route("/health", health, methods=["GET"])
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
