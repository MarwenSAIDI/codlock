"""The contract between the orchestrator and the Payment / Fitting agents.

This module is the single source of truth for every payload that crosses an agent
boundary. The orchestrator imports these models (or mirrors them in whatever it is
written in) and codes against them. Nothing here imports the A2A SDK, Gravv, or any
image model on purpose: the contract has to be readable and stable while the
implementations behind it are still being built.

Money is always ``Decimal``, never ``float``. A deposit is a real amount a real person
in Tunisia pays, and binary floating point loses millimes.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _Base(BaseModel):
    """Strict by default: an unexpected field is a contract drift bug, not a shrug."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


# --------------------------------------------------------------------------------------
# shared value objects
# --------------------------------------------------------------------------------------


class Money(_Base):
    """An amount in a named currency.

    ``currency`` is the currency the *customer sees* — TND for a Tunisian order. What
    Gravv actually settles in is the Payment Agent's problem, not the orchestrator's,
    and is reported back in :class:`GravvRefs.settlement`.
    """

    amount: Decimal = Field(ge=0, description="Non-negative. Use Decimal, never float.")
    currency: str = Field(default="TND", min_length=3, max_length=3)


class Channel(str, Enum):
    instagram = "instagram"
    whatsapp = "whatsapp"


class CustomerRef(_Base):
    """Who is paying. The Payment Agent needs enough to create a Gravv customer."""

    customer_id: str = Field(description="CODLOCK-side id, e.g. 'C123'.")
    full_name: str
    phone: str = Field(description="E.164 preferred, e.g. '+21620123456'.")
    email: str | None = None
    zone: str | None = Field(
        default=None,
        description="Delivery zone/governorate. Carried for audit; the risk decision "
        "itself is made upstream by the orchestrator's risk tool.",
    )


class ProductRef(_Base):
    """The catalog item the customer is buying, already matched upstream."""

    sku: str
    name: str
    image_url: str = Field(description="Catalog photo, publicly readable.")
    category: str = Field(description="e.g. 'dress', 'shorts', 'shoes'.")
    color: str | None = None
    size: str | None = None


# --------------------------------------------------------------------------------------
# Payment Agent — skill: collect_deposit
# --------------------------------------------------------------------------------------


class DepositStatus(str, Enum):
    not_required = "not_required"
    """Risk scoring returned a zero deposit. No Gravv call was made at all."""

    awaiting_payment = "awaiting_payment"
    """A checkout exists and the customer has not paid yet."""

    paid = "paid"
    expired = "expired"
    failed = "failed"


class GravvRefs(_Base):
    """Gravv-side identifiers, so the backend can reconcile without guessing."""

    seller_account_id: str | None = None
    seller_customer_id: str | None = None
    collection_id: str | None = None
    payment_link_id: str | None = None
    settlement: Money | None = Field(
        default=None,
        description="What Gravv actually moves, if it differs from the displayed "
        "currency (FX applied). None when settlement currency == display currency.",
    )
    environment: Literal["sandbox", "live"] | None = None


class CollectDepositInput(_Base):
    """Orchestrator -> Payment Agent. 'Risk said N, go make it payable.'

    The Payment Agent does **not** decide the amount. ``deposit`` arrives already
    decided by the orchestrator's risk-scoring tool; ``risk_score`` and ``deposit_rate``
    are carried only so the payment record explains itself later.
    """

    order_id: str = Field(description="Idempotency anchor. Two calls with the same "
                                      "order_id must not create two checkouts.")
    seller_id: str
    customer: CustomerRef
    order_total: Money
    deposit: Money = Field(description="Zero is legal and means 'no deposit required'.")
    deposit_rate: float = Field(ge=0, le=1, description="0.20 for 20%. Audit only.")
    risk_score: int = Field(ge=0, le=100, description="Audit only.")
    channel: Channel


class CollectDepositOutput(_Base):
    payment_id: str = Field(description="CODLOCK-side handle for this deposit.")
    order_id: str
    status: DepositStatus
    amount: Money
    checkout_url: str | None = Field(
        default=None, description="The one-tap link the customer opens. None when "
                                  "status is not_required or failed."
    )
    expires_at: datetime | None = None
    gravv: GravvRefs = Field(default_factory=GravvRefs)
    failure_reason: str | None = None


# --------------------------------------------------------------------------------------
# Payment Agent — skill: confirm_payment
# --------------------------------------------------------------------------------------


class ConfirmPaymentInput(_Base):
    payment_id: str
    order_id: str


class ConfirmPaymentOutput(_Base):
    payment_id: str
    order_id: str
    status: DepositStatus
    paid: Money | None = None
    paid_at: datetime | None = None
    failure_reason: str | None = None


# --------------------------------------------------------------------------------------
# Payment Agent — skill: settle_order
# --------------------------------------------------------------------------------------


class OrderOutcome(str, Enum):
    accepted = "accepted"
    refused = "refused"


class Disposition(str, Enum):
    applied_to_total = "applied_to_total"
    """Accepted: the deposit comes off what the customer still owes the courier."""

    retained_for_courier = "retained_for_courier"
    """Refused: the deposit covers the round trip instead of the seller eating it."""

    nothing_to_settle = "nothing_to_settle"
    """No deposit was ever taken (clean returning customer)."""


class SettleOrderInput(_Base):
    order_id: str
    payment_id: str
    outcome: OrderOutcome
    courier_fee: Money | None = Field(
        default=None, description="Required when outcome is refused, to compute whether "
                                  "the deposit actually covered the round trip."
    )


class SettleOrderOutput(_Base):
    order_id: str
    payment_id: str
    disposition: Disposition
    deposit_amount: Money
    remaining_due: Money | None = Field(
        default=None, description="Accepted: what the customer still pays on delivery."
    )
    courier_covered: Money | None = Field(
        default=None, description="Refused: how much of the courier fee the deposit ate."
    )
    seller_shortfall: Money | None = Field(
        default=None, description="Refused: what the seller still loses, if the deposit "
                                  "was smaller than the courier fee. Zero is the win case."
    )


# --------------------------------------------------------------------------------------
# Fitting Agent — skill: generate_preview
# --------------------------------------------------------------------------------------


class PreviewStatus(str, Enum):
    processing = "processing"
    ready = "ready"
    failed = "failed"


class MatchVerdict(str, Enum):
    good_match = "good_match"
    weak_match = "weak_match"
    """The render came out, but the item reads poorly on this customer. The
    orchestrator should offer a catalog alternative — the Fitting Agent deliberately
    has no catalog access of its own, so it reports rather than decides."""


class MatchAssessment(_Base):
    quality: float = Field(ge=0, le=1)
    verdict: MatchVerdict
    reason: str = Field(description="Short human-readable justification, shown to no one "
                                    "but useful at the pitch and in logs.")
    recommend_alternative: bool


class GeneratePreviewInput(_Base):
    request_id: str = Field(description="Idempotency anchor for the render.")
    order_id: str
    customer_photo_url: str
    product: ProductRef


class GeneratePreviewOutput(_Base):
    preview_id: str
    request_id: str
    status: PreviewStatus
    preview_image_url: str | None = Field(
        default=None, description="Set only when status is ready."
    )
    match: MatchAssessment | None = None
    from_cache: bool = Field(
        default=False,
        description="True when served from the pre-rendered fixture set rather than "
        "generated live. Kept explicit so a demo never silently pretends.",
    )
    failure_reason: str | None = None


class GetPreviewInput(_Base):
    """Poll. A render takes 10-30s, which is too long to hold a request open."""

    preview_id: str


__all__ = [
    "Money", "Channel", "CustomerRef", "ProductRef", "GravvRefs",
    "DepositStatus", "CollectDepositInput", "CollectDepositOutput",
    "ConfirmPaymentInput", "ConfirmPaymentOutput",
    "OrderOutcome", "Disposition", "SettleOrderInput", "SettleOrderOutput",
    "PreviewStatus", "MatchVerdict", "MatchAssessment",
    "GeneratePreviewInput", "GeneratePreviewOutput", "GetPreviewInput",
]
