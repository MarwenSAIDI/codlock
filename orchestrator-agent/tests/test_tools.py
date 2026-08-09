"""Internal tools: bound to an injected Supabase client, never a global one."""

from __future__ import annotations

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


def test_get_product_tool_matches_on_sku_alone():
    tools = OrchestratorTools(FakeSupabase(PRODUCTS))
    product = tools.get_product_tool("DRESS-BEIGE-001")
    assert product["sku"] == "DRESS-BEIGE-001"


def test_get_product_tool_narrows_by_size():
    tools = OrchestratorTools(FakeSupabase(PRODUCTS))
    product = tools.get_product_tool("DRESS-BEIGE-001", size="L")
    assert product["size"] == "L"


def test_get_product_tool_returns_empty_dict_when_no_match():
    tools = OrchestratorTools(FakeSupabase(PRODUCTS))
    assert tools.get_product_tool("NOPE", size="XS") == {}


@pytest.mark.parametrize(
    "method,args",
    [
        ("risk_score_tool", ("ord_1",)),
        ("get_order_tool", ("ord_1",)),
        ("create_order_tool", ("cust_1", [])),
        ("delete_order_tool", ("ord_1",)),
    ],
)
def test_unimplemented_tools_fail_loudly_not_silently(method, args):
    tools = OrchestratorTools(FakeSupabase(PRODUCTS))
    with pytest.raises(NotImplementedError):
        getattr(tools, method)(*args)


def test_as_list_exposes_every_tool_once():
    tools = OrchestratorTools(FakeSupabase(PRODUCTS))
    names = [fn.__name__ for fn in tools.as_list()]
    assert names == [
        "risk_score_tool",
        "get_product_tool",
        "get_order_tool",
        "create_order_tool",
        "delete_order_tool",
    ]
