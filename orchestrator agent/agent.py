"""CodLock orchestrator agent.

Coordinates order fulfillment by calling its own tools (risk scoring, product
lookup, order management) and delegating to specialized agents discovered
over A2A (e.g. payment, fitting).
"""

import os

from dotenv import load_dotenv
from google.adk import Agent
from google.adk.agents.remote_a2a_agent import RemoteA2aAgent
from google.adk.models.lite_llm import LiteLlm

load_dotenv()


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _load_remote_a2a_agents() -> list[RemoteA2aAgent]:
    """Build sub-agents for every peer configured in A2A_AGENTS.

    Expected format: "name=url,name=url,...", e.g.
    "payment=http://localhost:8001,fitting=http://localhost:8002".
    Each agent's card is resolved from f"{url}/.well-known/agent-card.json"
    lazily, on first delegation.
    """
    raw = os.environ.get("A2A_AGENTS", "")
    agents = []
    for entry in filter(None, (e.strip() for e in raw.split(","))):
        name, _, url = entry.partition("=")
        if not name or not url:
            raise RuntimeError(f"Invalid A2A_AGENTS entry: {entry!r}")
        agents.append(RemoteA2aAgent(name=name.strip(), agent_card=url.strip()))
    return agents


# --- Internal tools -------------------------------------------------------
# TODO: implement each of these; signatures are placeholders for now.


def risk_score_tool(order_id: str) -> dict:
    """Compute a fraud/risk score for an order.

    Args:
        order_id: Identifier of the order to score.
    """
    raise NotImplementedError("risk scoring tool is not implemented yet")


def get_product_tool(product_id: str) -> dict:
    """Fetch product details by id.

    Args:
        product_id: Identifier of the product to fetch.
    """
    raise NotImplementedError("product getter tool is not implemented yet")


def get_order_tool(order_id: str) -> dict:
    """Fetch an order by id.

    Args:
        order_id: Identifier of the order to fetch.
    """
    raise NotImplementedError("order getter tool is not implemented yet")


def create_order_tool(customer_id: str, items: list[dict]) -> dict:
    """Create a new order for a customer.

    Args:
        customer_id: Identifier of the customer placing the order.
        items: Line items for the order.
    """
    raise NotImplementedError("order creator tool is not implemented yet")


def delete_order_tool(order_id: str) -> dict:
    """Delete an existing order by id.

    Args:
        order_id: Identifier of the order to delete.
    """
    raise NotImplementedError("order deleter tool is not implemented yet")


root_agent = Agent(
    name="codlock_orchestrator",
    model=LiteLlm(
        model=_require_env("MODEL_NAME"),
        api_base=_require_env("MODEL_API_URL"),
        api_key=_require_env("MODEL_API_KEY"),
    ),
    description="Orchestrates CodLock order fulfillment across internal tools and peer agents.",
    instruction=(
        "You are the CodLock orchestrator agent. Use your internal tools to "
        "look up products, manage orders, and score order risk. Delegate to "
        "peer agents discovered over A2A when a request falls under their "
        "specialty."
    ),
    tools=[
        risk_score_tool,
        get_product_tool,
        get_order_tool,
        create_order_tool,
        delete_order_tool,
    ],
    sub_agents=_load_remote_a2a_agents(),
)
