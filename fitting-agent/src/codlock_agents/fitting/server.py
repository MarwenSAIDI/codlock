"""Fitting Agent: A2A server exposing the virtual try-on."""

from __future__ import annotations

from a2a.types import AgentSkill
from fastapi import FastAPI

from codlock_agents.a2a_support import SkillRouter
from codlock_agents.fitting.service import PreviewService, StubRenderer
from codlock_agents.nlu import Extractor, GeminiExtractor, UnavailableExtractor
from codlock_agents.schemas import (
    GeneratePreviewInput,
    GeneratePreviewOutput,
    GetPreviewInput,
)
from codlock_agents.serving import build_app, build_card, serve
from codlock_agents.settings import Settings, get_settings

SKILLS = [
    AgentSkill(
        id="generate_preview",
        name="Generate try-on preview",
        description=(
            "Render the matched catalog item on the customer's own photo. Returns "
            "immediately with status 'processing' — a render takes 10-30s, so poll "
            "get_preview rather than waiting on this call. Idempotent on request_id."
        ),
        tags=["vision", "try-on", "generative"],
        examples=['{"skill":"generate_preview","input":{"request_id":"req_1", ...}}'],
        input_modes=["application/json"],
        output_modes=["application/json"],
    ),
    AgentSkill(
        id="get_preview",
        name="Get preview result",
        description=(
            "Poll a render. Returns processing, then ready with the image URL and a "
            "match assessment, or failed with a reason. On a weak match the agent sets "
            "recommend_alternative — it has no catalog access, so choosing the "
            "alternative stays with the orchestrator."
        ),
        tags=["vision", "try-on"],
        input_modes=["application/json"],
        output_modes=["application/json"],
    ),
]


def build_router(settings: Settings) -> SkillRouter:
    router = SkillRouter()
    service = PreviewService(
        renderer=_select_renderer(settings),
        timeout_seconds=settings.preview_timeout_seconds,
    )

    @router.register("generate_preview", GeneratePreviewInput)
    async def _generate(request: GeneratePreviewInput) -> GeneratePreviewOutput:
        return await service.generate_preview(request)

    @router.register("get_preview", GetPreviewInput)
    async def _get(request: GetPreviewInput) -> GeneratePreviewOutput:
        return await service.get_preview(request)

    return router


def _select_extractor(settings: Settings) -> Extractor:
    """Only used for plain-text ADK delegations. Absent key means refuse, not guess."""
    if not settings.gemini_api_key:
        return UnavailableExtractor()
    return GeminiExtractor(settings.gemini_api_key, settings.nlu_model)


def _select_renderer(settings: Settings):
    if settings.stub_mode or settings.image_provider == "stub":
        return StubRenderer()
    if not settings.gemini_api_key:
        raise RuntimeError(
            "IMAGE_PROVIDER=gemini but GEMINI_API_KEY is not set."
        )
    from codlock_agents.fitting.gemini_renderer import GeminiRenderer

    return GeminiRenderer(settings)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    card = build_card(
        name="CODLOCK Fitting Agent",
        description=(
            "Shows the customer the product on themselves before any money is asked "
            "for, so a refusal at the door becomes less likely rather than just more "
            "expensive."
        ),
        url=f"{settings.fitting_public_url}/",
        skills=SKILLS,
    )
    return build_app(card, build_router(settings), _select_extractor(settings))


def main() -> None:
    settings = get_settings()
    app = create_app(settings)
    card = build_card(
        name="CODLOCK Fitting Agent",
        description="",
        url=f"{settings.fitting_public_url}/",
        skills=SKILLS,
    )
    serve(app, card, settings.fitting_host, settings.fitting_port, settings.log_level)


if __name__ == "__main__":
    main()
