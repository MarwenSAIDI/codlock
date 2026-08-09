#!/usr/bin/env python
"""Drive the REST bridge against the *live* peer agents.

The unit tests fake the peers, so they prove the bridge's logic but not the thing most
likely to be wrong at 9am on pitch day: whether two services written in two languages by
two people actually agree on the bytes. This script calls the real Fitting Agent (:8002,
Python) and the real Payment Agent (:8001, TypeScript) over A2A, through the same handler
the NestJS backend hits, with only Supabase faked.

    # in two other terminals, with STUB_MODE=true
    cd fitting-agent && uv run fitting-agent
    cd payment-agent  && npm start

    cd orchestrator-agent && uv run python scripts/smoke_bridge.py

Exit code 0 means the seam is sound. Anything else prints which leg failed and why.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from codlock_agents.orchestrator.bridge import (
    Bridge,
    CreatePaymentLinkBody,
    GeneratePreviewBody,
    RiskScoreBody,
)
from codlock_agents.orchestrator.peers import PeerClient, PeerError

FITTING_URL = os.environ.get("FITTING_PUBLIC_URL", "http://127.0.0.1:8002")
PAYMENT_URL = os.environ.get("PAYMENT_PUBLIC_URL", "http://127.0.0.1:8001")

# Stand-in for Supabase. The bridge only reads, and only these columns.
ROWS: dict[str, list[dict[str, Any]]] = {
    "customers": [
        {
            "id": "cust_1",
            "name": "Amina B.",
            "phone": "+21620123456",
            "zone": "Ariana",
            "total_orders": 10,
            "successful_orders": 8,
            "refused_orders": 2,
        }
    ],
    "products": [
        {
            "id": "prod_1",
            "sku": "DRESS-BEIGE-001",
            "title": "Beige Summer Dress",
            "image_url": "https://cdn.example.test/dress.jpg",
            "category": "dress",
            "sizes": ["S", "M", "L"],
            "colors": ["beige", "black"],
        }
    ],
    "orders": [
        {
            "id": "ord_1",
            "seller_id": "seller_1",
            "customer_id": "cust_1",
            "channel": "WHATSAPP",
            "total_price": 149,
            "currency": "TND",
            "risk_score": 72,
            "deposit_rate": 0.2,
            "status": "DEPOSIT_PENDING",
        },
        # A trusted returning customer: risk said zero, so no deposit is collected.
        {
            "id": "ord_trusted",
            "seller_id": "seller_1",
            "customer_id": "cust_1",
            "channel": "INSTAGRAM",
            "total_price": 89,
            "currency": "TND",
            "risk_score": 8,
            "deposit_rate": 0,
            "status": "DEPOSIT_PENDING",
        },
    ],
}


class FakeQuery:
    def __init__(self, rows):
        self._rows, self._filters = rows, []

    def eq(self, column, value):
        self._filters.append((column, value))
        return self

    def limit(self, _n):
        return self

    def execute(self):
        data = [r for r in self._rows if all(r.get(c) == v for c, v in self._filters)]
        return type("R", (), {"data": data})()


class FakeSupabase:
    def table(self, name):
        rows = ROWS.get(name, [])
        return type("T", (), {"select": lambda _s, *a, **k: FakeQuery(rows)})()


def show(label: str, payload: Any) -> None:
    print(f"\n=== {label} ===")
    print(json.dumps(payload, indent=2, ensure_ascii=False, default=str))


async def main() -> int:
    peers = PeerClient({"fitting": FITTING_URL, "payment": PAYMENT_URL})
    bridge = Bridge(
        supabase=FakeSupabase(),
        peers=peers,
        preview_timeout_seconds=120.0,
        preview_poll_interval_seconds=1.0,
    )

    failures: list[str] = []

    # Module 4 — risk. No peer involved; proves the Supabase-backed scorer.
    try:
        risk = await bridge.score_risk(RiskScoreBody(customerId="cust_1"))
        show("POST /agent/risk/score", risk)
        assert 0 <= risk["score"] <= 100, "score out of range"
    except Exception as exc:  # noqa: BLE001 - a smoke script reports, never crashes
        failures.append(f"risk: {exc}")

    # Module 3 — fitting. Real A2A round trip to the Python agent, including the poll.
    try:
        preview = await bridge.generate_preview(
            GeneratePreviewBody(
                customerId="cust_1",
                productId="prod_1",
                customerPhotoUrl="https://cdn.example.test/customer.jpg",
                orderId="ord_1",
                size="M",
            )
        )
        show("POST /agent/fitting/generate-preview", preview)
        assert preview["previewPhotoUrl"], "no preview URL came back"
    except Exception as exc:  # noqa: BLE001
        failures.append(f"fitting: {exc}")

    # Module 5 — payment. Real A2A round trip to the TypeScript agent. This is the leg
    # where money formatting and the channel enum have to be exactly right.
    try:
        link = await bridge.create_payment_link(
            CreatePaymentLinkBody(
                orderId="ord_1",
                customerId="cust_1",
                amount=29.8,
                currency="TND",
                idempotencyKey="deposit:ord_1",
            )
        )
        show("POST /agent/payment/create-link", link)
        assert link["paymentId"], "no payment id came back"
        assert link["status"] in {"awaiting_payment", "paid", "not_required"}, link["status"]
    except Exception as exc:  # noqa: BLE001
        failures.append(f"payment: {exc}")

    # A zero deposit must be a clean "not_required", never an error: a trusted returning
    # customer is the happy path the product is proudest of. Its own order id, because
    # collect_deposit is idempotent on order_id — reusing ord_1 would only replay it.
    try:
        free = await bridge.create_payment_link(
            CreatePaymentLinkBody(
                orderId="ord_trusted",
                customerId="cust_1",
                amount=0,
                currency="TND",
                idempotencyKey="deposit:ord_trusted",
            )
        )
        show("POST /agent/payment/create-link (zero deposit)", free)
        assert free["status"] == "not_required", free["status"]
        assert free["paymentUrl"] is None
    except Exception as exc:  # noqa: BLE001
        failures.append(f"zero deposit: {exc}")

    # Re-collecting a *changed* deposit on an order that already has a checkout must be
    # refused, not silently replayed at the old amount.
    try:
        await bridge.create_payment_link(
            CreatePaymentLinkBody(
                orderId="ord_1",
                customerId="cust_1",
                amount=45,
                currency="TND",
                idempotencyKey="deposit:ord_1",
            )
        )
        failures.append("changed deposit: expected a conflict, got a link")
    except PeerError as exc:
        if exc.error_type != "ConflictError":
            failures.append(f"changed deposit: expected ConflictError, got {exc.error_type}")
        else:
            show("POST /agent/payment/create-link (deposit changed)", {"refused": exc.message})
    except Exception as exc:  # noqa: BLE001
        failures.append(f"changed deposit: {exc}")

    print()
    if failures:
        for failure in failures:
            print(f"FAILED  {failure}")
        return 1
    print("OK  all three bridge routes round-tripped through the live agents.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
