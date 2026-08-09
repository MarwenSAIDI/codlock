"""Risk scoring over the order history the backend already writes to Supabase.

One implementation, two callers: the ADK tool (``risk_score_tool``, reached by an LLM
turn) and the REST route the NestJS backend calls (``POST /agent/risk/score``). They
must never disagree about what a score means, so neither owns the arithmetic.

The score is 0 (safe) to 100 (high risk) and combines the two causes of refusal the
product actually observes:

* the customer's own refusal history — the strongest signal, and the only one that
  sharpens with every delivered order;
* the refusal rate of their delivery zone — a weaker, shared prior that carries the
  cost of a bad neighbourhood without blaming a first-time buyer for all of it.

A first-time buyer has no history, so they get :data:`FIRST_TIME_BUYER_SCORE` — the same
65 the backend uses in its local fallback (``risk.service.ts``). Two components agreeing
on the unknown-customer case matters more than the exact number: it means a degraded
orchestrator changes the deposit by nothing at all.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

#: A customer with no delivered orders yet. Deliberately equal to the backend's
#: local fallback so an outage does not move the deposit.
FIRST_TIME_BUYER_SCORE = 65

#: How many points a fully-refusing zone can add on top of personal history. Small
#: on purpose: where you live is evidence, not guilt.
ZONE_WEIGHT = 20


class CustomerNotFound(LookupError):
    """No such customer row — the caller passed an id Supabase does not know."""


@dataclass
class RiskAssessment:
    score: int
    factors: dict[str, Any] = field(default_factory=dict)

    def as_response(self) -> dict[str, Any]:
        """Shape expected by the backend's ``RiskScoreResponse`` (camelCase, by contract)."""
        return {"score": self.score, "factors": self.factors}


def clamp_score(value: float) -> int:
    return max(0, min(100, round(value)))


def score_customer(supabase: Any, customer_id: str, zone: str | None = None) -> RiskAssessment:
    """Score one customer, optionally overriding the zone on their profile.

    The caller's ``zone`` wins when given (the order's delivery zone may differ from the
    customer's home zone); otherwise the profile's zone is used.
    """
    customer = _fetch_customer(supabase, customer_id)
    if not customer:
        raise CustomerNotFound(customer_id)

    total = _as_int(customer.get("total_orders"))
    refused = _as_int(customer.get("refused_orders"))
    successful = _as_int(customer.get("successful_orders"))
    effective_zone = zone or customer.get("zone") or None

    first_time_buyer = total <= 0
    refusal_rate = 0.0 if first_time_buyer else min(1.0, refused / total)
    zone_rate = _zone_refusal_rate(supabase, effective_zone)

    base = FIRST_TIME_BUYER_SCORE if first_time_buyer else refusal_rate * 100
    score = clamp_score(base + (zone_rate or 0.0) * ZONE_WEIGHT)

    return RiskAssessment(
        score=score,
        factors={
            "refusalHistoryRate": round(refusal_rate, 4),
            "completedOrders": successful,
            "zoneRefusalRate": None if zone_rate is None else round(zone_rate, 4),
            "firstTimeBuyer": first_time_buyer,
        },
    )


def _fetch_customer(supabase: Any, customer_id: str) -> dict[str, Any]:
    rows = (
        supabase.table("customers")
        .select("id,zone,total_orders,successful_orders,refused_orders")
        .eq("id", customer_id)
        .limit(1)
        .execute()
        .data
    )
    return rows[0] if rows else {}


def _zone_refusal_rate(supabase: Any, zone: str | None) -> float | None:
    """Refused-over-delivered across every customer in the zone.

    ``None`` when there is no zone or the zone has no delivery history yet — an
    unknown rate is reported as unknown rather than smuggled in as zero.
    """
    if not zone:
        return None
    try:
        rows = (
            supabase.table("customers")
            .select("total_orders,refused_orders")
            .eq("zone", zone)
            .execute()
            .data
        ) or []
    except Exception as exc:  # noqa: BLE001 - a missing zone prior must not fail the score
        logger.warning("zone refusal rate lookup failed for %r: %s", zone, exc)
        return None

    total = sum(_as_int(row.get("total_orders")) for row in rows)
    refused = sum(_as_int(row.get("refused_orders")) for row in rows)
    if total <= 0:
        return None
    return min(1.0, refused / total)


def _as_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


__all__ = [
    "FIRST_TIME_BUYER_SCORE",
    "ZONE_WEIGHT",
    "CustomerNotFound",
    "RiskAssessment",
    "clamp_score",
    "score_customer",
]
