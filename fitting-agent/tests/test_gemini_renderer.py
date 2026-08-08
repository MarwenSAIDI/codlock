"""The try-on render pipeline, against a mocked Gemini.

Mocked deliberately: the render logic has to be provable without spending quota or
waiting 30 seconds, and — as of writing — the project's API key has no image-generation
quota at all, so a live test would be red for a reason that is not our bug.
``scripts/smoke_render.py`` is the live counterpart, for looking at the output by eye.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import httpx
import pytest

from codlock_agents.fitting.gemini_renderer import GeminiRenderer
from codlock_agents.fitting.storage import LocalPreviewStore
from codlock_agents.schemas import GeneratePreviewInput, MatchVerdict, ProductRef
from codlock_agents.settings import Settings

PNG = b"\x89PNG\r\n\x1a\n" + b"fake image bytes"

REQUEST = GeneratePreviewInput(
    request_id="req_test",
    order_id="ord_test",
    customer_photo_url="https://example.test/customer.jpg",
    product=ProductRef(
        sku="DRESS-BEIGE-001",
        name="Beige Summer Dress",
        image_url="https://example.test/dress.jpg",
        category="dress",
        color="beige",
        size="M",
    ),
)


def settings() -> Settings:
    return Settings(
        stub_mode=False,
        image_provider="gemini",
        gemini_api_key="test-key",
        gemini_image_model="gemini-3-pro-image",
        nlu_model="gemini-flash-latest",
        _env_file=None,  # type: ignore[call-arg]
    )


def image_response() -> dict:
    return {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {
                            "inlineData": {
                                "mimeType": "image/png",
                                "data": base64.b64encode(PNG).decode(),
                            }
                        }
                    ]
                }
            }
        ]
    }


def text_response(text: str) -> dict:
    return {"candidates": [{"content": {"parts": [{"text": text}]}}]}


def make_renderer(handler, tmp_path: Path) -> GeminiRenderer:
    def factory(**kwargs):
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), **kwargs)

    store = LocalPreviewStore(tmp_path, "http://fitting.test")
    return GeminiRenderer(settings(), store, client_factory=factory)


def routing_handler(
    *, image=None, assess=None, customer_type="image/jpeg", image_status=200
):
    """Route the four calls a render makes: two fetches, generate, assess."""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "example.test" in url:
            return httpx.Response(
                200, content=PNG, headers={"content-type": customer_type}
            )
        if "gemini-3-pro-image" in url:
            if image_status != 200:
                return httpx.Response(image_status, json={"error": {"message": "quota"}})
            return httpx.Response(200, json=image or image_response())
        return httpx.Response(200, json=assess or text_response(
            json.dumps({"quality": 0.86, "reason": "Colour suits her; cut works."})
        ))

    return handler


async def test_happy_path_renders_stores_and_scores(tmp_path):
    renderer = make_renderer(routing_handler(), tmp_path)
    result = await renderer.render(REQUEST)

    assert result.image_url == "http://fitting.test/previews/req_test.png"
    assert (tmp_path / "req_test.png").read_bytes() == PNG
    assert result.match.quality == pytest.approx(0.86)
    assert result.match.verdict is MatchVerdict.good_match
    assert result.match.recommend_alternative is False
    # A live render must never claim to be a fixture.
    assert result.from_cache is False


async def test_a_low_score_asks_the_orchestrator_for_an_alternative(tmp_path):
    renderer = make_renderer(
        routing_handler(assess=text_response(
            json.dumps({"quality": 0.21, "reason": "Colour washes her out."})
        )),
        tmp_path,
    )
    result = await renderer.render(REQUEST)

    assert result.match.verdict is MatchVerdict.weak_match
    assert result.match.recommend_alternative is True
    # The agent reports; it never picks the alternative itself.
    assert result.image_url


async def test_render_survives_a_failed_assessment(tmp_path):
    # A missing score is a smaller loss than a missing preview.
    renderer = make_renderer(
        routing_handler(assess=text_response("not json at all")), tmp_path
    )
    result = await renderer.render(REQUEST)

    assert result.image_url
    assert "unavailable" in result.match.reason.lower()


async def test_a_refusal_is_surfaced_verbatim(tmp_path):
    # When the model answers with words where an image should be, that text is
    # usually actionable — do not flatten it into "render failed".
    renderer = make_renderer(
        routing_handler(image=text_response("I can't edit photos of real people.")),
        tmp_path,
    )
    with pytest.raises(RuntimeError, match="can't edit photos"):
        await renderer.render(REQUEST)


async def test_quota_exhaustion_names_the_status_code(tmp_path):
    renderer = make_renderer(routing_handler(image_status=429), tmp_path)
    with pytest.raises(RuntimeError, match="429"):
        await renderer.render(REQUEST)


async def test_a_non_image_url_is_rejected_before_calling_the_model(tmp_path):
    renderer = make_renderer(routing_handler(customer_type="text/html"), tmp_path)
    with pytest.raises(RuntimeError, match="not an image"):
        await renderer.render(REQUEST)


async def test_quality_is_clamped_into_range(tmp_path):
    renderer = make_renderer(
        routing_handler(assess=text_response(
            json.dumps({"quality": 4.2, "reason": "over-eager model"})
        )),
        tmp_path,
    )
    result = await renderer.render(REQUEST)
    assert result.match.quality == 1.0
