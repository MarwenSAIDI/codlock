"""Internal tools: bound to an injected Supabase client, never a global one.

The fake below mimics PostgREST's *shape*, not its semantics, so it can only prove
wiring. Where a filter has to match the real schema — ``products.sizes`` is a text[],
not a ``size`` column — the test asserts on the filter that was issued rather than on a
row the fake chose to return. A fake that accepts a query Postgres would reject is worse
than no test at all: that is exactly how ``.eq("size", ...)`` survived here.
"""

from __future__ import annotations

import pytest

from codlock_agents.orchestrator.agent import OrchestratorTools


class FakeQuery:
    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows
        self.filters: list[tuple[str, object]] = []
        self.contains_filters: list[tuple[str, object]] = []

    def eq(self, column: str, value: object) -> FakeQuery:
        self.filters.append((column, value))
        return self

    def contains(self, column: str, value: object) -> FakeQuery:
        """PostgREST array containment — how a text[] column is actually filtered."""
        self.contains_filters.append((column, value))
        return self

    def limit(self, n: int) -> FakeQuery:
        return self

    def execute(self):
        class _Result:
            def __init__(self, data):
                self.data = data

        matching = [
            row
            for row in self._rows
            if all(row.get(col) == val for col, val in self.filters)
            and all(
                isinstance(row.get(col), list) and set(val) <= set(row[col])
                for col, val in self.contains_filters
            )
        ]
        return _Result(matching)


class FakeMutation:
    def __init__(self, log: list, kind: str, payload: object = None) -> None:
        self._log = log
        self._kind = kind
        self._payload = payload
        self._filters: list[tuple[str, object]] = []

    def eq(self, column: str, value: object) -> FakeMutation:
        self._filters.append((column, value))
        return self

    def execute(self):
        self._log.append((self._kind, self._payload, self._filters))

        class _Result:
            def __init__(self, data):
                self.data = data

        if self._kind == "insert":
            row = {"id": "ord_new", **(self._payload or {})}
            return _Result([row])
        return _Result([])


class FakeTable:
    def __init__(self, rows: list[dict], log: list) -> None:
        self._rows = rows
        self._log = log

    def select(self, *_args, **_kwargs) -> FakeQuery:
        return FakeQuery(self._rows)

    def insert(self, payload: dict) -> FakeMutation:
        return FakeMutation(self._log, "insert", payload)

    def delete(self) -> FakeMutation:
        return FakeMutation(self._log, "delete")


class FakeSupabase:
    def __init__(self, rows: list[dict], tables: dict[str, list[dict]] | None = None) -> None:
        self._rows = rows
        self._tables = tables or {}
        self.mutations: list = []
        self.queried: list[FakeQuery] = []

    def table(self, name: str) -> FakeTable:
        rows = self._tables.get(name, self._rows if name == "products" else [])
        table = FakeTable(rows, self.mutations)
        original_select = table.select

        def recording_select(*args, **kwargs):
            query = original_select(*args, **kwargs)
            self.queried.append(query)
            return query

        table.select = recording_select  # type: ignore[method-assign]
        return table


# `sizes`/`colors` are Postgres arrays on one row per SKU — matching the real schema in
# backend/db/schema.sql, which is what the orchestrator queries in production.
PRODUCTS = [
    {
        "id": "prod_1",
        "sku": "DRESS-BEIGE-001",
        "title": "Beige Summer Dress",
        "sizes": ["M", "L"],
        "colors": ["beige"],
    },
]


def make_tools(**tables) -> tuple[OrchestratorTools, FakeSupabase]:
    supabase = FakeSupabase(PRODUCTS, {"products": PRODUCTS, **tables})
    return OrchestratorTools(supabase), supabase


# ── get_product_tool ──────────────────────────────────────────────────────────


def test_get_product_tool_matches_on_sku_alone():
    tools, _ = make_tools()
    assert tools.get_product_tool("DRESS-BEIGE-001")["sku"] == "DRESS-BEIGE-001"


def test_get_product_tool_narrows_by_size_through_array_containment():
    """Regression: `.eq("size", ...)` names a column products does not have, so the
    whole query fails at PostgREST — never a miss, always an error."""
    tools, supabase = make_tools()
    product = tools.get_product_tool("DRESS-BEIGE-001", size="L")
    assert product["sku"] == "DRESS-BEIGE-001"

    query = supabase.queried[-1]
    assert ("sizes", ["L"]) in query.contains_filters
    assert not any(col == "size" for col, _ in query.filters)


def test_get_product_tool_returns_empty_dict_when_the_size_is_not_stocked():
    tools, _ = make_tools()
    assert tools.get_product_tool("DRESS-BEIGE-001", size="XS") == {}


def test_get_product_tool_returns_empty_dict_when_no_match():
    tools, _ = make_tools()
    assert tools.get_product_tool("NOPE") == {}


# ── orders ────────────────────────────────────────────────────────────────────

DRAFT_ORDER = {"id": "ord_1", "customer_id": "cust_1", "status": "DRAFT"}
PAID_ORDER = {"id": "ord_2", "customer_id": "cust_1", "status": "DEPOSIT_PAID"}


def test_get_order_tool_returns_the_row():
    tools, _ = make_tools(orders=[DRAFT_ORDER])
    assert tools.get_order_tool("ord_1")["status"] == "DRAFT"


def test_get_order_tool_reports_a_miss_as_an_error_the_model_can_read():
    """An LLM cannot act on a raised exception; it can act on a sentence."""
    tools, _ = make_tools(orders=[DRAFT_ORDER])
    assert "error" in tools.get_order_tool("ghost")


def test_create_order_tool_inserts_a_draft():
    tools, supabase = make_tools(orders=[])
    result = tools.create_order_tool(
        customer_id="cust_1",
        seller_id="seller_1",
        channel="whatsapp",
        total_price=149.0,
        items=[{"productId": "prod_1", "quantity": 1}],
    )
    assert result["id"] == "ord_new"

    kind, payload, _ = supabase.mutations[-1]
    assert kind == "insert"
    assert payload["status"] == "DRAFT"
    assert payload["channel"] == "WHATSAPP"  # the Postgres enum is upper case
    assert payload["currency"] == "TND"
    # Risk and deposit are decided by later steps; an order is never born pre-assessed.
    assert "risk_score" not in payload and "deposit_amount" not in payload


def test_create_order_tool_rejects_a_channel_outside_the_enum():
    tools, supabase = make_tools(orders=[])
    result = tools.create_order_tool(
        customer_id="cust_1", seller_id="s", channel="tiktok", total_price=10, items=[]
    )
    assert "error" in result
    assert supabase.mutations == []  # rejected before touching the database


def test_create_order_tool_rejects_a_negative_total():
    tools, supabase = make_tools(orders=[])
    result = tools.create_order_tool(
        customer_id="cust_1", seller_id="s", channel="WHATSAPP", total_price=-1, items=[]
    )
    assert "error" in result
    assert supabase.mutations == []


def test_delete_order_tool_removes_a_pre_payment_order():
    tools, supabase = make_tools(orders=[DRAFT_ORDER])
    result = tools.delete_order_tool("ord_1")
    assert result["deleted"] is True
    assert supabase.mutations[-1][0] == "delete"


def test_delete_order_tool_refuses_once_money_is_involved():
    """From DEPOSIT_PENDING on, the row is a financial record — cancel, never delete."""
    tools, supabase = make_tools(orders=[PAID_ORDER])
    result = tools.delete_order_tool("ord_2")
    assert "error" in result
    assert "DEPOSIT_PAID" in result["error"]
    assert supabase.mutations == []


def test_delete_order_tool_reports_an_unknown_order():
    tools, _ = make_tools(orders=[DRAFT_ORDER])
    assert "error" in tools.delete_order_tool("ghost")


# ── risk_score_tool ───────────────────────────────────────────────────────────


def test_risk_score_tool_scores_the_orders_customer():
    customer = {
        "id": "cust_1",
        "zone": None,
        "total_orders": 4,
        "successful_orders": 3,
        "refused_orders": 1,
    }
    tools, _ = make_tools(orders=[DRAFT_ORDER], customers=[customer])
    result = tools.risk_score_tool("ord_1")
    assert result["order_id"] == "ord_1"
    assert result["score"] == 25  # 1 refusal in 4, no zone prior
    assert result["factors"]["firstTimeBuyer"] is False


def test_risk_score_tool_reports_an_unknown_order():
    tools, _ = make_tools(orders=[], customers=[])
    assert "error" in tools.risk_score_tool("ghost")


def test_risk_score_tool_reports_an_order_whose_customer_vanished():
    tools, _ = make_tools(orders=[DRAFT_ORDER], customers=[])
    assert "error" in tools.risk_score_tool("ord_1")


# ── wiring ────────────────────────────────────────────────────────────────────


def test_as_list_exposes_every_tool_once():
    tools, _ = make_tools()
    names = [fn.__name__ for fn in tools.as_list()]
    assert names == [
        "risk_score_tool",
        "get_product_tool",
        "get_order_tool",
        "create_order_tool",
        "delete_order_tool",
    ]


@pytest.mark.parametrize(
    "method,args",
    [
        ("risk_score_tool", ("ord_1",)),
        ("get_order_tool", ("ord_1",)),
        ("delete_order_tool", ("ord_1",)),
    ],
)
def test_no_tool_raises_notimplementederror_any_more(method, args):
    """These four were stubs that crashed the agent mid-turn. Regression guard."""
    tools, _ = make_tools(orders=[], customers=[])
    getattr(tools, method)(*args)  # must not raise
