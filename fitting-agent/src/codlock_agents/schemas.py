"""The contract between the orchestrator and the Fitting Agent.

Single source of truth for every payload crossing this agent's boundary. Nothing here
imports the A2A SDK or an image model on purpose: the contract has to stay readable and
stable while the implementation behind it changes.

The Payment Agent's half of the contract lives in ``payment-agent/src/schemas.ts`` —
it is a separate service in a separate language, which A2A makes invisible to callers.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


class _Base(BaseModel):
    """Strict by default: an unexpected field is contract drift, not a shrug."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ProductRef(_Base):
    """The catalog item the customer is buying, already matched upstream."""

    sku: str
    name: str
    image_url: str = Field(description="Catalog photo, publicly readable.")
    category: str = Field(description="e.g. 'dress', 'shorts', 'shoes'.")
    color: str | None = None
    size: str | None = None


class PreviewStatus(str, Enum):
    processing = "processing"
    ready = "ready"
    failed = "failed"


class MatchVerdict(str, Enum):
    good_match = "good_match"
    weak_match = "weak_match"
    """The render came out, but the item reads poorly on this customer. The
    orchestrator should offer a catalog alternative — this agent deliberately has no
    catalog access of its own, so it reports rather than decides."""


class MatchAssessment(_Base):
    quality: float = Field(ge=0, le=1)
    verdict: MatchVerdict
    reason: str = Field(description="Short justification. Useful in logs and at the pitch.")
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
    "ProductRef",
    "PreviewStatus",
    "MatchVerdict",
    "MatchAssessment",
    "GeneratePreviewInput",
    "GeneratePreviewOutput",
    "GetPreviewInput",
]
