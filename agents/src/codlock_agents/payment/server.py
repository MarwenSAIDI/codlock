"""Payment Agent: A2A server exposing the deposit lifecycle."""

from __future__ import annotations

from a2a.types import AgentSkill
from fastapi import FastAPI

from codlock_agents.a2a_support import SkillRouter
from codlock_agents.payment.service import PaymentService, StubBackend
from codlock_agents.schemas import (
    CollectDepositInput,
    CollectDepositOutput,
    ConfirmPaymentInput,
    ConfirmPaymentOutput,
    SettleOrderInput,
    SettleOrderOutput,
)
from codlock_agents.serving import build_app, build_card, serve
from codlock_agents.settings import Settings, get_settings

SKILLS = [
    AgentSkill(
        id="collect_deposit",
        name="Collect deposit",
        description=(
            "Turn an already-decided deposit amount into something the customer can pay "
            "in one tap through Gravv. Does not decide the amount — risk scoring does "
            "that upstream. A deposit of zero is legal and returns status "
            "'not_required' without touching Gravv."
        ),
        tags=["payments", "gravv", "deposit"],
        examples=['{"skill":"collect_deposit","input":{"order_id":"ord_1", ...}}'],
        input_modes=["application/json"],
        output_modes=["application/json"],
    ),
    AgentSkill(
        id="confirm_payment",
        name="Confirm payment",
        description=(
            "Poll whether the deposit has actually been paid. Returns awaiting_payment "
            "until it clears, then paid. Safe to call repeatedly."
        ),
        tags=["payments", "gravv"],
        input_modes=["application/json"],
        output_modes=["application/json"],
    ),
    AgentSkill(
        id="settle_order",
        name="Settle order",
        description=(
            "Close the loop once the courier reports back. Accepted: the deposit is "
            "applied to the total and the remaining balance is returned. Refused: the "
            "deposit is retained against the courier's round trip, and any seller "
            "shortfall is reported honestly."
        ),
        tags=["payments", "settlement"],
        input_modes=["application/json"],
        output_modes=["application/json"],
    ),
]


def build_router(settings: Settings) -> SkillRouter:
    router = SkillRouter()
    service = PaymentService(backend=_select_backend(settings))

    @router.register("collect_deposit", CollectDepositInput)
    async def _collect(request: CollectDepositInput) -> CollectDepositOutput:
        return await service.collect_deposit(request)

    @router.register("confirm_payment", ConfirmPaymentInput)
    async def _confirm(request: ConfirmPaymentInput) -> ConfirmPaymentOutput:
        return await service.confirm_payment(request)

    @router.register("settle_order", SettleOrderInput)
    async def _settle(request: SettleOrderInput) -> SettleOrderOutput:
        return await service.settle_order(request)

    return router


def _select_backend(settings: Settings):
    if settings.stub_mode:
        return StubBackend()
    if not settings.gravv_api_key:
        raise RuntimeError(
            "STUB_MODE is off but GRAVV_API_KEY is not set. Either set a "
            "grvSec_sandbox_... key or leave STUB_MODE=true."
        )
    from codlock_agents.payment.gravv_backend import GravvBackend

    return GravvBackend(settings)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    card = build_card(
        name="CODLOCK Payment Agent",
        description=(
            "Collects the risk-decided deposit through Gravv before a cash-on-delivery "
            "order ships, and settles it once the courier reports the outcome."
        ),
        url=f"{settings.payment_public_url}/",
        skills=SKILLS,
    )
    return build_app(card, build_router(settings))


def main() -> None:
    settings = get_settings()
    app = create_app(settings)
    card = build_card(
        name="CODLOCK Payment Agent",
        description="",
        url=f"{settings.payment_public_url}/",
        skills=SKILLS,
    )
    serve(app, card, settings.payment_host, settings.payment_port, settings.log_level)


if __name__ == "__main__":
    main()
