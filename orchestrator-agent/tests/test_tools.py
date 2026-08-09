"""Internal tools: bound to an injected Supabase client and backend HTTP client."""

from __future__ import annotations

import json

import httpx
import pytest

from codlock_agents.orchestrator.agent import OrchestratorTools


class FakeQuery:
    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows
        self.filters: list[tuple[str, object]] = []

    def eq(self, column: str, value: object) -> FakeQuery:
        self.filters.append((column, value))
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
        ]
        return _Result(matching)


class FakeTable:
    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows

    def select(self, *_args, **_kwargs) -> FakeQuery:
        return FakeQuery(self._rows)


class FakeSupabase:
    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows

    def table(self, name: str) -> FakeTable:
        assert name == "products"
        return FakeTable(self._rows)


PRODUCTS = [
    {"sku": "DRESS-BEIGE-001", "size": "M", "name": "Beige Summer Dress"},
    {"sku": "DRESS-BEIGE-001", "size": "L", "name": "Beige Summer Dress"},
]

ORDER = {
    "id": "ord_1",
    "customer_id": "cust_1",
    "status": "DRAFT",
    "total_price": 159.8,
}


def fake_backend(handler) -> httpx.Client:
    """A real httpx.Client wired to an in-process handler instead of a socket,
    so tool code exercises its actual request/response path (headers, json
    encoding, raise_for_status) without touching the network."""
    return httpx.Client(
        base_url="http://backend.test/api/v1",
        transport=httpx.MockTransport(handler),
    )


def json_handler(status_code: int, body: dict):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=body, request=request)

    return handler


def test_get_product_tool_matches_on_sku_alone():
    tools = OrchestratorTools(FakeSupabase(PRODUCTS), fake_backend(json_handler(200, {})))
    product = tools.get_product_tool("DRESS-BEIGE-001")
    assert product["sku"] == "DRESS-BEIGE-001"


def test_get_product_tool_narrows_by_size():
    tools = OrchestratorTools(FakeSupabase(PRODUCTS), fake_backend(json_handler(200, {})))
    product = tools.get_product_tool("DRESS-BEIGE-001", size="L")
    assert product["size"] == "L"


def test_get_product_tool_returns_empty_dict_when_no_match():
    tools = OrchestratorTools(FakeSupabase(PRODUCTS), fake_backend(json_handler(200, {})))
    assert tools.get_product_tool("NOPE", size="XS") == {}


def test_risk_score_tool_evaluates_risk_for_the_order():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={**ORDER, "status": "RISK_EVALUATED", "risk_score": 62})

    tools = OrchestratorTools(FakeSupabase(PRODUCTS), fake_backend(handler))
    result = tools.risk_score_tool("ord_1")

    assert result["risk_score"] == 62
    assert seen[0].method == "POST"
    assert seen[0].url.path == "/api/v1/orders/ord_1/evaluate-risk"


def test_get_order_tool_fetches_the_order():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/api/v1/orders/ord_1"
        return httpx.Response(200, json=ORDER)

    tools = OrchestratorTools(FakeSupabase(PRODUCTS), fake_backend(handler))
    assert tools.get_order_tool("ord_1") == ORDER


def test_get_order_tool_raises_on_a_missing_order():
    tools = OrchestratorTools(
        FakeSupabase(PRODUCTS), fake_backend(json_handler(404, {"message": "not found"}))
    )
    with pytest.raises(httpx.HTTPStatusError):
        tools.get_order_tool("nope")


def test_create_order_tool_posts_customer_channel_and_items():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(201, json=ORDER)

    tools = OrchestratorTools(FakeSupabase(PRODUCTS), fake_backend(handler))
    items = [{"productId": "prod_1", "quantity": 2, "size": "M"}]
    result = tools.create_order_tool("cust_1", "WHATSAPP", items)

    assert result == ORDER
    request = seen[0]
    assert request.method == "POST"
    assert request.url.path == "/api/v1/orders"
    assert json.loads(request.content) == {
        "customerId": "cust_1",
        "channel": "WHATSAPP",
        "items": items,
    }


def test_delete_order_tool_cancels_the_order():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/api/v1/orders/ord_1/cancel"
        return httpx.Response(200, json={**ORDER, "status": "CANCELLED"})

    tools = OrchestratorTools(FakeSupabase(PRODUCTS), fake_backend(handler))
    result = tools.delete_order_tool("ord_1")
    assert result["status"] == "CANCELLED"


def test_delete_order_tool_raises_when_order_is_not_cancellable():
    tools = OrchestratorTools(
        FakeSupabase(PRODUCTS),
        fake_backend(json_handler(400, {"message": "Order cannot be cancelled (is SHIPPED)"})),
    )
    with pytest.raises(httpx.HTTPStatusError):
        tools.delete_order_tool("ord_1")


def test_as_list_exposes_every_tool_once():
    tools = OrchestratorTools(FakeSupabase(PRODUCTS), fake_backend(json_handler(200, {})))
    names = [fn.__name__ for fn in tools.as_list()]
    assert names == [
        "risk_score_tool",
        "get_product_tool",
        "get_order_tool",
        "create_order_tool",
        "delete_order_tool",
    ]
