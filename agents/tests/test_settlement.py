"""Settlement arithmetic — the part that expresses CODLOCK's actual claim.

If these numbers are wrong the pitch is wrong, so they are tested directly rather
than only through the agent.
"""

from decimal import Decimal

import pytest

from codlock_agents.payment.service import settle
from codlock_agents.schemas import Disposition, Money, OrderOutcome


def tnd(amount: str) -> Money:
    return Money(amount=Decimal(amount), currency="TND")


def _settle(**kwargs):
    return settle(order_id="ord_1", payment_id="pay_1", **kwargs)


def test_accepted_deposit_comes_off_the_total():
    result = _settle(
        order_total=tnd("149.000"),
        deposit=tnd("29.800"),
        deposit_paid=True,
        outcome=OrderOutcome.accepted,
        courier_fee=None,
    )
    assert result.disposition is Disposition.applied_to_total
    assert result.remaining_due.amount == Decimal("119.200")
    assert result.seller_shortfall is None


def test_refused_deposit_covers_the_courier_round_trip():
    result = _settle(
        order_total=tnd("149.000"),
        deposit=tnd("29.800"),
        deposit_paid=True,
        outcome=OrderOutcome.refused,
        courier_fee=tnd("8.000"),
    )
    assert result.disposition is Disposition.retained_for_courier
    assert result.courier_covered.amount == Decimal("8.000")
    # The whole point: the seller loses nothing on a refusal.
    assert result.seller_shortfall.amount == Decimal("0")


def test_refused_with_deposit_smaller_than_courier_fee_reports_the_gap():
    result = _settle(
        order_total=tnd("40.000"),
        deposit=tnd("5.000"),
        deposit_paid=True,
        outcome=OrderOutcome.refused,
        courier_fee=tnd("8.000"),
    )
    assert result.courier_covered.amount == Decimal("5.000")
    assert result.seller_shortfall.amount == Decimal("3.000")


def test_zero_deposit_refusal_leaves_the_seller_fully_exposed():
    """The status quo CODLOCK removes — reported honestly, not hidden."""
    result = _settle(
        order_total=tnd("149.000"),
        deposit=tnd("0"),
        deposit_paid=False,
        outcome=OrderOutcome.refused,
        courier_fee=tnd("8.000"),
    )
    assert result.disposition is Disposition.nothing_to_settle
    assert result.seller_shortfall.amount == Decimal("8.000")


def test_unpaid_deposit_is_treated_as_no_deposit():
    """An abandoned checkout must not be settled as if money had arrived."""
    result = _settle(
        order_total=tnd("149.000"),
        deposit=tnd("29.800"),
        deposit_paid=False,
        outcome=OrderOutcome.refused,
        courier_fee=tnd("8.000"),
    )
    assert result.disposition is Disposition.nothing_to_settle
    assert result.seller_shortfall.amount == Decimal("8.000")


def test_deposit_larger_than_total_never_produces_negative_balance():
    result = _settle(
        order_total=tnd("20.000"),
        deposit=tnd("25.000"),
        deposit_paid=True,
        outcome=OrderOutcome.accepted,
        courier_fee=None,
    )
    assert result.remaining_due.amount == Decimal("0")


def test_millimes_survive_the_round_trip():
    """TND has three decimal places. Float arithmetic loses them; Decimal does not."""
    result = _settle(
        order_total=tnd("149.999"),
        deposit=tnd("29.999"),
        deposit_paid=True,
        outcome=OrderOutcome.accepted,
        courier_fee=None,
    )
    assert result.remaining_due.amount == Decimal("120.000")


@pytest.mark.parametrize("outcome", list(OrderOutcome))
def test_every_outcome_names_a_disposition(outcome):
    result = _settle(
        order_total=tnd("100.000"),
        deposit=tnd("20.000"),
        deposit_paid=True,
        outcome=outcome,
        courier_fee=tnd("8.000"),
    )
    assert result.disposition in set(Disposition)
