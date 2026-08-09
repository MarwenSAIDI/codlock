"""Build a runnable A2A service from an agent card and a skill router.

Both agents are the same shape, so the wiring lives here once. Each agent module only
declares *what* it does; this decides *how* it is served.
"""

from __future__ import annotations

import logging

import uvicorn
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import add_a2a_routes_to_fastapi, create_agent_card_routes
from a2a.server.routes.jsonrpc_routes import create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import AgentCapabilities, AgentCard, AgentInterface, AgentSkill
from a2a.utils import AGENT_CARD_WELL_KNOWN_PATH, DEFAULT_RPC_URL, TransportProtocol
from fastapi import FastAPI

from codlock_agents.a2a_support import RoutedAgentExecutor, SkillRouter
from codlock_agents.nlu import Extractor

logger = logging.getLogger(__name__)


def build_card(
    *,
    name: str,
    description: str,
    url: str,
    skills: list[AgentSkill],
    version: str = "0.1.0",
) -> AgentCard:
    return AgentCard(
        name=name,
        description=description,
        version=version,
        supported_interfaces=[
            AgentInterface(url=url, protocol_binding=TransportProtocol.JSONRPC)
        ],
        capabilities=AgentCapabilities(streaming=False, push_notifications=False),
        default_input_modes=["application/json"],
        default_output_modes=["application/json"],
        skills=skills,
    )


def build_app(
    card: AgentCard, router: SkillRouter, extractor: Extractor | None = None
) -> FastAPI:
    handler = DefaultRequestHandler(
        agent_executor=RoutedAgentExecutor(router, extractor),
        task_store=InMemoryTaskStore(),
        agent_card=card,
    )
    app = FastAPI(title=card.name, version=card.version, description=card.description)
    add_a2a_routes_to_fastapi(
        app,
        agent_card_routes=create_agent_card_routes(card),
        jsonrpc_routes=create_jsonrpc_routes(handler, DEFAULT_RPC_URL),
    )

    @app.get("/health", tags=["ops"])
    async def health() -> dict[str, object]:
        """Cheap liveness probe for whoever deploys this on Sunday."""
        return {"status": "ok", "agent": card.name, "skills": router.skills}

    return app


def serve(app: FastAPI, card: AgentCard, host: str, port: int, log_level: str) -> None:
    logging.basicConfig(
        level=log_level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
    )
    logger.info("%s listening on http://%s:%d", card.name, host, port)
    logger.info("agent card at http://%s:%d%s", host, port, AGENT_CARD_WELL_KNOWN_PATH)
    uvicorn.run(app, host=host, port=port, log_level=log_level.lower())
