"""CodLock orchestrator agent.

Coordinates order fulfillment by calling its own tools (risk scoring, product
lookup, order management) and delegating to specialized agents discovered
over A2A (e.g. payment, fitting).

The Supabase client, the backend HTTP client, and the list of remote peers
are all injectable into :func:`build_agent` so tests can exercise agent
wiring without a live Supabase project, a live backend, or live peer
services.
"""

from __future__ import annotations

import httpx
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


def build_backend_client(settings: Settings) -> httpx.Client:
    """HTTP client for the CODLOCK NestJS backend, pre-authenticated.

    Every order/risk route the backend exposes is seller-scoped via its JWT
    bearer auth, so the token is attached once here rather than per call.
    """
    return httpx.Client(
        base_url=settings.backend_base_url,
        headers={"Authorization": f"Bearer {settings.backend_api_token}"},
        timeout=10.0,
    )


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
    """Internal tools bound to a Supabase client and a backend HTTP client.

    Kept as instance methods, rather than free functions reaching for
    process-global clients, so tests can supply fakes instead of talking to
    a real Supabase project or a live backend.
    """

    def __init__(self, supabase: Client, backend: httpx.Client) -> None:
        self._supabase = supabase
        self._backend = backend

    def risk_score_tool(self, order_id: str) -> dict:
        """Run the risk engine for an order and attach its deposit terms.

        Calls ``POST /orders/{order_id}/evaluate-risk`` on the CODLOCK
        backend, which scores the order's customer and channel and persists
        the resulting risk tier and deposit amount. Only valid for an order
        in DRAFT or PREVIEW_GENERATED status.

        Args:
            order_id: Identifier of the order to score.

        Returns:
            The order after evaluation, including its risk_score,
            deposit_rate, and deposit_amount.
        """
        response = self._backend.post(f"/orders/{order_id}/evaluate-risk")
        response.raise_for_status()
        return response.json()

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

        Calls ``GET /orders/{order_id}`` on the CODLOCK backend.

        Args:
            order_id: Identifier of the order to fetch.
        """
        response = self._backend.get(f"/orders/{order_id}")
        response.raise_for_status()
        return response.json()

    def create_order_tool(self, customer_id: str, channel: str, items: list[dict]) -> dict:
        """Create a new DRAFT order for a customer.

        Calls ``POST /orders`` on the CODLOCK backend.

        Args:
            customer_id: Identifier of the customer placing the order. The
                customer must already exist for the seller the backend token
                belongs to.
            channel: Social channel the order originated from — one of
                "WHATSAPP" or "INSTAGRAM".
            items: Line items, up to 50, each shaped like
                {"productId": str, "quantity": int, "size": str (optional),
                "color": str (optional)}.

        Returns:
            The newly created order, in DRAFT status.
        """
        response = self._backend.post(
            "/orders",
            json={"customerId": customer_id, "channel": channel, "items": items},
        )
        response.raise_for_status()
        return response.json()

    def delete_order_tool(self, order_id: str) -> dict:
        """Cancel an order abandoned before fulfilment.

        Calls ``POST /orders/{order_id}/cancel``. The backend has no hard
        delete for orders — cancellation is the closest equivalent, and is
        only allowed before a deposit has been paid.

        Args:
            order_id: Identifier of the order to cancel.

        Returns:
            The order in CANCELLED status.
        """
        response = self._backend.post(f"/orders/{order_id}/cancel")
        response.raise_for_status()
        return response.json()

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
    backend: httpx.Client | None = None,
    remote_agents: list[RemoteA2aAgent] | None = None,
) -> Agent:
    """Assemble the root orchestrator agent from settings."""
    tools = OrchestratorTools(
        supabase if supabase is not None else build_supabase_client(settings),
        backend if backend is not None else build_backend_client(settings),
    )
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
