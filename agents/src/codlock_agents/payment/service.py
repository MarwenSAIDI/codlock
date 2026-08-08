"""Payment Agent logic: deposit lifecycle and settlement arithmetic.

Deliberately free of LLM reasoning. Money movement is a fixed sequence of calls with a
fixed set of outcomes; an agent improvising over payment tools is the thing that breaks
on stage. The intelligence in CODLOCK lives in risk scoring (upstream) and the fitting
room (the other agent).

The settlement maths here is real, not stubbed — it needs no external service, and it
is the part that expresses the product's whole claim: refused, the deposit eats the
courier's round trip instead of the seller; accepted, it comes off the total.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Protocol

from codlock_agents.schemas import (
    CollectDepositInput,
    CollectDepositOutput,
    ConfirmPaymentInput,
    ConfirmPaymentOutput,
    DepositStatus,
    Disposition,
    GravvRefs,
    Money,
    OrderOutcome,
    SettleOrderInput,
    SettleOrderOutput,
)

CHECKOUT_TTL = timedelta(hours=24)


# --------------------------------------------------------------------------------------
# record keeping
# --------------------------------------------------------------------------------------


@dataclass
class PaymentRecord:
    """What the agent remembers about one deposit.

    In-memory on purpose for now: the durable copy belongs in the backend's Supabase
    ``orders`` table, and the backend owner owns that. Restarting the agent mid-demo
    loses these, which is a known and accepted limitation.
    """

    payment_id: str
    order_id: str
    seller_id: str
    customer_id: str
    order_total: Money
    deposit: Money
    status: DepositStatus
    checkout_url: str | None = None
    expires_at: datetime | None = None
    gravv: GravvRefs = field(default_factory=GravvRefs)
    paid_at: datetime | None = None
    poll_count: int = 0


class PaymentStore:
    def __init__(self) -> None:
        self._by_payment: dict[str, PaymentRecord] = {}
        self._by_order: dict[str, str] = {}

    def put(self, record: PaymentRecord) -> None:
        self._by_payment[record.payment_id] = record
        self._by_order[record.order_id] = record.payment_id

    def by_payment_id(self, payment_id: str) -> PaymentRecord | None:
        return self._by_payment.get(payment_id)

    def by_order_id(self, order_id: str) -> PaymentRecord | None:
        payment_id = self._by_order.get(order_id)
        return self._by_payment.get(payment_id) if payment_id else None


# --------------------------------------------------------------------------------------
# backends
# --------------------------------------------------------------------------------------


@dataclass
class Checkout:
    """What a payment backend hands back once a deposit is payable."""

    checkout_url: str
    refs: GravvRefs


class PaymentBackend(Protocol):
    async def open_checkout(self, request: CollectDepositInput) -> Checkout: ...

    async def poll_status(self, record: PaymentRecord) -> DepositStatus: ...


class StubBackend:
    """Answers from fixtures. No network, no credentials, no Gravv.

    ``poll_status`` reports ``awaiting_payment`` once and ``paid`` from the second poll
    onward, so the orchestrator is forced to write real polling rather than assuming an
    instant success it will not get in production.
    """

    async def open_checkout(self, request: CollectDepositInput) -> Checkout:
        token = uuid.uuid4().hex[:12]
        return Checkout(
            checkout_url=f"https://checkout.sandbox.gravv.xyz/stub/{token}",
            refs=GravvRefs(
                seller_account_id=f"acc_stub_{request.seller_id}",
                seller_customer_id=f"cus_stub_{request.seller_id}",
                collection_id=f"pi_stub_{token}",
                environment="sandbox",
            ),
        )

    async def poll_status(self, record: PaymentRecord) -> DepositStatus:
        if record.expires_at and datetime.now(timezone.utc) > record.expires_at:
            return DepositStatus.expired
        return (
            DepositStatus.awaiting_payment
            if record.poll_count <= 1
            else DepositStatus.paid
        )


# --------------------------------------------------------------------------------------
# service
# --------------------------------------------------------------------------------------


class PaymentService:
    def __init__(self, backend: PaymentBackend, store: PaymentStore | None = None) -> None:
        self._backend = backend
        self._store = store or PaymentStore()

    async def collect_deposit(self, request: CollectDepositInput) -> CollectDepositOutput:
        existing = self._store.by_order_id(request.order_id)
        if existing is not None:
            # order_id is the idempotency anchor: never open a second checkout.
            return _record_to_collect_output(existing)

        if request.deposit.amount == 0:
            record = PaymentRecord(
                payment_id=f"pay_{uuid.uuid4().hex[:12]}",
                order_id=request.order_id,
                seller_id=request.seller_id,
                customer_id=request.customer.customer_id,
                order_total=request.order_total,
                deposit=request.deposit,
                status=DepositStatus.not_required,
            )
            self._store.put(record)
            return _record_to_collect_output(record)

        checkout = await self._backend.open_checkout(request)
        record = PaymentRecord(
            payment_id=f"pay_{uuid.uuid4().hex[:12]}",
            order_id=request.order_id,
            seller_id=request.seller_id,
            customer_id=request.customer.customer_id,
            order_total=request.order_total,
            deposit=request.deposit,
            status=DepositStatus.awaiting_payment,
            checkout_url=checkout.checkout_url,
            expires_at=datetime.now(timezone.utc) + CHECKOUT_TTL,
            gravv=checkout.refs,
        )
        self._store.put(record)
        return _record_to_collect_output(record)

    async def confirm_payment(self, request: ConfirmPaymentInput) -> ConfirmPaymentOutput:
        record = self._store.by_payment_id(request.payment_id) or self._store.by_order_id(
            request.order_id
        )
        if record is None:
            return ConfirmPaymentOutput(
                payment_id=request.payment_id,
                order_id=request.order_id,
                status=DepositStatus.failed,
                failure_reason=f"No payment {request.payment_id!r} for order "
                               f"{request.order_id!r}.",
            )

        if record.status in (DepositStatus.not_required, DepositStatus.paid):
            return _record_to_confirm_output(record)

        record.poll_count += 1
        record.status = await self._backend.poll_status(record)
        if record.status is DepositStatus.paid and record.paid_at is None:
            record.paid_at = datetime.now(timezone.utc)
        self._store.put(record)
        return _record_to_confirm_output(record)

    async def settle_order(self, request: SettleOrderInput) -> SettleOrderOutput:
        record = self._store.by_payment_id(request.payment_id) or self._store.by_order_id(
            request.order_id
        )
        if record is None:
            raise LookupError(
                f"No payment {request.payment_id!r} for order {request.order_id!r}. "
                "settle_order must follow a collect_deposit."
            )
        return settle(
            order_total=record.order_total,
            deposit=record.deposit,
            deposit_paid=record.status is DepositStatus.paid,
            outcome=request.outcome,
            courier_fee=request.courier_fee,
            order_id=record.order_id,
            payment_id=record.payment_id,
        )


def settle(
    *,
    order_total: Money,
    deposit: Money,
    deposit_paid: bool,
    outcome: OrderOutcome,
    courier_fee: Money | None,
    order_id: str,
    payment_id: str,
) -> SettleOrderOutput:
    """Pure settlement arithmetic. Separated out so it is trivially testable.

    A deposit that was never actually paid settles as if it were zero — the seller is
    exposed for the full courier fee, which is precisely the situation CODLOCK exists
    to remove and so must be reported honestly rather than papered over.
    """
    currency = order_total.currency
    held = deposit.amount if deposit_paid else Decimal(0)

    if held == 0:
        shortfall = None
        if outcome is OrderOutcome.refused and courier_fee is not None:
            shortfall = Money(amount=courier_fee.amount, currency=courier_fee.currency)
        return SettleOrderOutput(
            order_id=order_id,
            payment_id=payment_id,
            disposition=Disposition.nothing_to_settle,
            deposit_amount=Money(amount=Decimal(0), currency=currency),
            remaining_due=(
                Money(amount=order_total.amount, currency=currency)
                if outcome is OrderOutcome.accepted
                else None
            ),
            seller_shortfall=shortfall,
        )

    if outcome is OrderOutcome.accepted:
        remaining = max(Decimal(0), order_total.amount - held)
        return SettleOrderOutput(
            order_id=order_id,
            payment_id=payment_id,
            disposition=Disposition.applied_to_total,
            deposit_amount=Money(amount=held, currency=currency),
            remaining_due=Money(amount=remaining, currency=currency),
        )

    fee = courier_fee.amount if courier_fee else Decimal(0)
    covered = min(held, fee)
    return SettleOrderOutput(
        order_id=order_id,
        payment_id=payment_id,
        disposition=Disposition.retained_for_courier,
        deposit_amount=Money(amount=held, currency=currency),
        courier_covered=Money(amount=covered, currency=currency),
        seller_shortfall=Money(amount=max(Decimal(0), fee - held), currency=currency),
    )


# --------------------------------------------------------------------------------------
# record -> contract
# --------------------------------------------------------------------------------------


def _record_to_collect_output(record: PaymentRecord) -> CollectDepositOutput:
    return CollectDepositOutput(
        payment_id=record.payment_id,
        order_id=record.order_id,
        status=record.status,
        amount=record.deposit,
        checkout_url=record.checkout_url,
        expires_at=record.expires_at,
        gravv=record.gravv,
    )


def _record_to_confirm_output(record: PaymentRecord) -> ConfirmPaymentOutput:
    return ConfirmPaymentOutput(
        payment_id=record.payment_id,
        order_id=record.order_id,
        status=record.status,
        paid=record.deposit if record.status is DepositStatus.paid else None,
        paid_at=record.paid_at,
    )
