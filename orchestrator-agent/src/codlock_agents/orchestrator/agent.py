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

from codlock_agents.orchestrator.peers import parse_peer_map
from codlock_agents.orchestrator.risk import CustomerNotFound, score_customer
from codlock_agents.orchestrator.settings import Settings

#: Order states from which a hard delete is allowed. Past this point money or a courier
#: is involved and the row is a financial record — the backend's ``cancel`` flow moves
#: such an order to CANCELLED instead, which is recoverable. See ``orders.service.ts``.
DELETABLE_ORDER_STATUSES = frozenset({"DRAFT", "PREVIEW_GENERATED", "RISK_EVALUATED"})

#: Mirrors the Postgres ``channel`` enum. Upper case on the wire to Supabase.
VALID_CHANNELS = frozenset({"WHATSAPP", "INSTAGRAM"})

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
    return [
        RemoteA2aAgent(name=name, agent_card=url)
        for name, url in parse_peer_map(raw).items()
    ]


class OrchestratorTools:
    """Internal tools bound to a Supabase client.

    Kept as instance methods, rather than free functions reaching for a
    process-global client, so tests can supply a fake client instead of
    talking to a real project.

    Every tool returns a plain dict, and reports a problem as ``{"error": ...}`` rather
    than raising: the caller is an LLM, and an exception becomes an opaque tool failure it
    cannot explain to the user, while a returned message is something it can act on.
    """

    def __init__(self, supabase: Client) -> None:
        self._supabase = supabase

    def risk_score_tool(self, order_id: str) -> dict:
        """Compute a refusal-risk score (0 safe - 100 high risk) for an order.

        Scores the order's customer from their own refusal history and their delivery
        zone's refusal rate. Does not decide the deposit — the backend maps a score onto
        a deposit rate.

        Args:
            order_id: Identifier of the order to score.

        Returns:
            The score and the factors behind it, or an ``error`` key if the order or its
            customer is unknown.
        """
        order = self.get_order_tool(order_id)
        if "error" in order:
            return order
        try:
            assessment = score_customer(self._supabase, str(order["customer_id"]))
        except CustomerNotFound:
            return {"error": f"Order {order_id} references a customer that no longer exists."}
        return {"order_id": order_id, **assessment.as_response()}

    def get_product_tool(self, sku: str, size: str | None = None) -> dict:
        """Fetch a product by SKU, optionally narrowed to one it stocks in a given size.

        Args:
            sku: Product reference code shared across size/color variants.
            size: Size variant to match (one of XS, S, M, L, XL, XXL, XXXL).

        Returns:
            The matching product as a dict, or an empty dict if none was found.
        """
        query = self._supabase.table("products").select("*").eq("sku", sku)
        if size:
            # `sizes` is a Postgres text[] on the products table — one row lists every
            # size it stocks. Filtering with .eq("size", ...) asks for a column that does
            # not exist and fails the whole query at PostgREST.
            query = query.contains("sizes", [size])
        rows = query.limit(1).execute().data
        return rows[0] if rows else {}

    def get_order_tool(self, order_id: str) -> dict:
        """Fetch an order by id.

        Args:
            order_id: Identifier of the order to fetch.

        Returns:
            The order row, or an ``error`` key when no such order exists.
        """
        rows = (
            self._supabase.table("orders").select("*").eq("id", order_id).limit(1).execute().data
        )
        if not rows:
            return {"error": f"No order {order_id}."}
        return rows[0]

    def create_order_tool(
        self,
        customer_id: str,
        seller_id: str,
        channel: str,
        total_price: float,
        items: list[dict],
        currency: str = "TND",
    ) -> dict:
        """Create a new DRAFT order for a customer.

        The order starts in DRAFT with no risk score and no deposit: scoring and the
        deposit decision are separate steps, so an order is never created already
        pretending to have been assessed.

        Args:
            customer_id: Identifier of the customer placing the order.
            seller_id: Identifier of the seller the order belongs to.
            channel: Where the order came from — WHATSAPP or INSTAGRAM.
            total_price: Order total in the order's currency, e.g. 149.0.
            items: Line items, each e.g. {"productId": ..., "quantity": 1, "size": "M"}.
            currency: ISO 4217 code for the price. Defaults to TND.

        Returns:
            The created order row, or an ``error`` key describing what was rejected.
        """
        normalised_channel = str(channel or "").strip().upper()
        if normalised_channel not in VALID_CHANNELS:
            return {"error": f"channel must be one of {sorted(VALID_CHANNELS)}, got {channel!r}."}
        if total_price is None or float(total_price) < 0:
            return {"error": "total_price must be zero or greater."}

        payload = {
            "customer_id": customer_id,
            "seller_id": seller_id,
            "channel": normalised_channel,
            "total_price": float(total_price),
            "currency": str(currency or "TND").upper(),
            "item_details": items or [],
            "status": "DRAFT",
        }
        rows = self._supabase.table("orders").insert(payload).execute().data
        if not rows:
            return {"error": "Supabase accepted the insert but returned no row."}
        return rows[0]

    def delete_order_tool(self, order_id: str) -> dict:
        """Delete an order that has not yet reached payment.

        Refuses once a deposit or a courier is involved: from DEPOSIT_PENDING onwards the
        row is a financial record, and cancelling such an order is the backend's job
        (it moves it to CANCELLED, which is recoverable and auditable).

        Args:
            order_id: Identifier of the order to delete.

        Returns:
            ``{"deleted": true, ...}`` on success, otherwise an ``error`` key.
        """
        order = self.get_order_tool(order_id)
        if "error" in order:
            return order
        status = str(order.get("status") or "")
        if status not in DELETABLE_ORDER_STATUSES:
            return {
                "error": f"Order {order_id} is {status}; only "
                f"{sorted(DELETABLE_ORDER_STATUSES)} can be deleted. Cancel it instead.",
            }
        self._supabase.table("orders").delete().eq("id", order_id).execute()
        return {"deleted": True, "order_id": order_id, "previous_status": status}

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
