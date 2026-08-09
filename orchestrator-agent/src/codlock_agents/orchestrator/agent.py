"""CodLock orchestrator agent.

Coordinates order fulfillment by calling its own tools (risk scoring, product
lookup, order management) and delegating to specialized agents discovered
over A2A (e.g. payment, fitting).

The Supabase client and the list of remote peers are both injectable into
:func:`build_agent` so tests can exercise agent wiring without a live
Supabase project or live peer services.
"""

from __future__ import annotations

from google.adk import Agent
from google.adk.agents.remote_a2a_agent import RemoteA2aAgent
from google.adk.models.lite_llm import LiteLlm
from supabase import Client, create_client

from codlock_agents.orchestrator.settings import Settings

INSTRUCTION = (
    "You are the CodLock orchestrator agent. Use your internal tools to "
    "look up products, manage orders, and score order risk. Delegate to "
    "peer agents discovered over A2A when a request falls under their "
    "specialty."
)


def build_supabase_client(settings: Settings) -> Client:
    return create_client(settings.supabase_url, settings.supabase_key)


def parse_a2a_agents(raw: str) -> list[RemoteA2aAgent]:
    """Build sub-agents for every peer configured in A2A_AGENTS.

    Expected format: "name=url,name=url,...", e.g.
    "payment=http://localhost:8001,fitting=http://localhost:8002".
    Each agent's card is resolved from f"{url}/.well-known/agent-card.json"
    lazily, on first delegation.
    """
    agents: list[RemoteA2aAgent] = []
    for entry in filter(None, (e.strip() for e in raw.split(","))):
        name, _, url = entry.partition("=")
        if not name or not url:
            raise RuntimeError(f"Invalid A2A_AGENTS entry: {entry!r}")
        agents.append(RemoteA2aAgent(name=name.strip(), agent_card=url.strip()))
    return agents


class OrchestratorTools:
    """Internal tools bound to a Supabase client.

    Kept as instance methods, rather than free functions reaching for a
    process-global client, so tests can supply a fake client instead of
    talking to a real project.
    """

    # TODO: implement the tools below; signatures are placeholders for now.

    def __init__(self, supabase: Client) -> None:
        self._supabase = supabase

    def risk_score_tool(self, order_id: str) -> dict:
        """Compute a fraud/risk score for an order.

        Args:
            order_id: Identifier of the order to score.
        """
        raise NotImplementedError("risk scoring tool is not implemented yet")

    def get_product_tool(self, sku: str, size: str | None = None) -> dict:
        """Fetch a product by SKU, optionally narrowed to a specific size.

        Args:
            sku: Product reference code shared across size/color variants.
            size: Size variant to match (one of XS, S, M, L, XL, XXL, XXXL).

        Returns:
            The matching product as a dict, or an empty dict if none was found.
        """
        query = self._supabase.table("products").select("*").eq("sku", sku)
        if size:
            query = query.eq("size", size)
        rows = query.limit(1).execute().data
        return rows[0] if rows else {}

    def get_order_tool(self, order_id: str) -> dict:
        """Fetch an order by id.

        Args:
            order_id: Identifier of the order to fetch.
        """
        raise NotImplementedError("order getter tool is not implemented yet")

    def create_order_tool(self, customer_id: str, items: list[dict]) -> dict:
        """Create a new order for a customer.

        Args:
            customer_id: Identifier of the customer placing the order.
            items: Line items for the order.
        """
        raise NotImplementedError("order creator tool is not implemented yet")

    def delete_order_tool(self, order_id: str) -> dict:
        """Delete an existing order by id.

        Args:
            order_id: Identifier of the order to delete.
        """
        raise NotImplementedError("order deleter tool is not implemented yet")

    def as_list(self) -> list:
        return [
            self.risk_score_tool,
            self.get_product_tool,
            self.get_order_tool,
            self.create_order_tool,
            self.delete_order_tool,
        ]


def build_agent(
    settings: Settings,
    *,
    supabase: Client | None = None,
    remote_agents: list[RemoteA2aAgent] | None = None,
) -> Agent:
    """Assemble the root orchestrator agent from settings."""
    tools = OrchestratorTools(supabase if supabase is not None else build_supabase_client(settings))
    sub_agents = (
        parse_a2a_agents(settings.a2a_agents) if remote_agents is None else remote_agents
    )

    return Agent(
        name="codlock_orchestrator",
        model=LiteLlm(
            model=settings.model_name,
            api_base=settings.model_api_url,
            api_key=settings.model_api_key,
        ),
        description=(
            "Orchestrates CodLock order fulfillment across internal tools and peer agents."
        ),
        instruction=INSTRUCTION,
        tools=tools.as_list(),
        sub_agents=sub_agents,
    )
