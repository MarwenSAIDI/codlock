"""Fitting Agent logic: turn a customer photo plus a catalog item into a try-on preview.

A render takes 10-30 seconds, which is far too long to hold a request open while a
customer waits in a chat. So ``generate_preview`` starts the work and returns
immediately with ``processing``; the orchestrator polls ``get_preview``.

The agent reports match quality but never picks an alternative itself. It has no
catalog access by design — that is the orchestrator's Get-product tool. Reporting
"this reads poorly, quality 0.31" and letting the orchestrator decide keeps one owner
for catalog decisions.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from typing import Protocol

from codlock_agents.schemas import (
    GeneratePreviewInput,
    GeneratePreviewOutput,
    GetPreviewInput,
    MatchAssessment,
    MatchVerdict,
    PreviewStatus,
)

logger = logging.getLogger(__name__)

WEAK_MATCH_BELOW = 0.55


@dataclass
class RenderResult:
    image_url: str
    match: MatchAssessment
    from_cache: bool = False


class Renderer(Protocol):
    async def render(self, request: GeneratePreviewInput) -> RenderResult: ...


class StubRenderer:
    """A fixture render with realistic latency.

    The delay is deliberate. If the orchestrator is built against an instant response
    it will get written synchronously, and then the first real render breaks it.
    """

    def __init__(self, delay_seconds: float = 3.0) -> None:
        self._delay = delay_seconds

    async def render(self, request: GeneratePreviewInput) -> RenderResult:
        await asyncio.sleep(self._delay)
        return RenderResult(
            image_url=(
                "https://placehold.co/768x1024/efe6dc/2b2b2b.png"
                f"?text={request.product.name.replace(' ', '+')}"
            ),
            match=MatchAssessment(
                quality=0.86,
                verdict=MatchVerdict.good_match,
                reason="Stub renderer: fixed high-confidence result.",
                recommend_alternative=False,
            ),
            from_cache=True,
        )


@dataclass
class PreviewRecord:
    preview_id: str
    request_id: str
    order_id: str
    status: PreviewStatus
    image_url: str | None = None
    match: MatchAssessment | None = None
    from_cache: bool = False
    failure_reason: str | None = None


class PreviewService:
    def __init__(self, renderer: Renderer, timeout_seconds: float = 60.0) -> None:
        self._renderer = renderer
        self._timeout = timeout_seconds
        self._records: dict[str, PreviewRecord] = {}
        self._by_request: dict[str, str] = {}
        self._tasks: set[asyncio.Task[None]] = set()

    async def generate_preview(
        self, request: GeneratePreviewInput
    ) -> GeneratePreviewOutput:
        existing_id = self._by_request.get(request.request_id)
        if existing_id is not None:
            # request_id is the idempotency anchor: never render the same thing twice.
            return _to_output(self._records[existing_id])

        record = PreviewRecord(
            preview_id=f"prv_{uuid.uuid4().hex[:12]}",
            request_id=request.request_id,
            order_id=request.order_id,
            status=PreviewStatus.processing,
        )
        self._records[record.preview_id] = record
        self._by_request[request.request_id] = record.preview_id

        task = asyncio.create_task(self._run(record, request))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

        return _to_output(record)

    async def get_preview(self, request: GetPreviewInput) -> GeneratePreviewOutput:
        record = self._records.get(request.preview_id)
        if record is None:
            return GeneratePreviewOutput(
                preview_id=request.preview_id,
                request_id="",
                status=PreviewStatus.failed,
                failure_reason=f"No preview {request.preview_id!r}.",
            )
        return _to_output(record)

    async def _run(self, record: PreviewRecord, request: GeneratePreviewInput) -> None:
        try:
            result = await asyncio.wait_for(
                self._renderer.render(request), timeout=self._timeout
            )
        except asyncio.TimeoutError:
            record.status = PreviewStatus.failed
            record.failure_reason = (
                f"Render exceeded {self._timeout:.0f}s. The orchestrator should proceed "
                "to risk scoring without a preview rather than block the order."
            )
            logger.warning("preview %s timed out", record.preview_id)
            return
        except Exception as exc:  # noqa: BLE001 - a dead image model must not kill the order
            record.status = PreviewStatus.failed
            record.failure_reason = f"{type(exc).__name__}: {exc}"
            logger.exception("preview %s failed", record.preview_id)
            return

        record.status = PreviewStatus.ready
        record.image_url = result.image_url
        record.match = result.match
        record.from_cache = result.from_cache


def assess(quality: float, reason: str) -> MatchAssessment:
    """Turn a raw quality score into the verdict the orchestrator branches on."""
    weak = quality < WEAK_MATCH_BELOW
    return MatchAssessment(
        quality=quality,
        verdict=MatchVerdict.weak_match if weak else MatchVerdict.good_match,
        reason=reason,
        recommend_alternative=weak,
    )


def _to_output(record: PreviewRecord) -> GeneratePreviewOutput:
    return GeneratePreviewOutput(
        preview_id=record.preview_id,
        request_id=record.request_id,
        status=record.status,
        preview_image_url=record.image_url,
        match=record.match,
        from_cache=record.from_cache,
        failure_reason=record.failure_reason,
    )
