"""The virtual fitting room: put the catalog item on the customer's own photo.

This is the behavioural half of CODLOCK. The deposit makes a refusal *cost* something;
this makes the customer less likely to want to refuse at all, because they have already
seen themselves in the product before the courier exists.

Two calls to Gemini per preview:

1. **Render** — the image model receives the customer photo and the catalog photo and
   returns a composite. Nano Banana Pro by default, because this render is what judges
   are looking at.
2. **Assess** — a fast text model compares the render against the catalog photo and
   scores how well the item reads on this customer. That score is what drives
   ``recommend_alternative``; the agent reports it and the orchestrator decides, because
   the catalog belongs to the orchestrator.

If the assessment call fails the render still ships. A missing score is a smaller loss
than a missing preview.
"""

from __future__ import annotations

import base64
import json
import logging

import httpx

from codlock_agents.fitting.service import RenderResult
from codlock_agents.fitting.storage import PreviewStore
from codlock_agents.schemas import GeneratePreviewInput, ProductRef
from codlock_agents.settings import Settings

logger = logging.getLogger(__name__)

GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models"
MAX_SOURCE_BYTES = 12 * 1024 * 1024

RENDER_PROMPT = """Photorealistic virtual try-on.

Image 1 is the customer. Image 2 is a garment from a shop catalogue.

Produce a single photograph of the person in image 1 wearing the garment from image 2.

Hold constant, exactly as in image 1: the person's face and identity, their body shape
and proportions, their pose, the camera angle, the background, and the lighting
direction and warmth.

Change only the garment. Carry over its true colour, pattern, fabric texture, length and
cut from image 2. Let it drape and fold the way that fabric really would on this body in
this pose, with shadows consistent with the existing light.

The result must look like an ordinary photograph of that person, not a collage, not a
render, and not a retouched product shot. Output the image only."""

ASSESS_PROMPT = """Image 1 is a shop catalogue photo. Image 2 is a generated try-on of
that item on a customer.

Judge how well the item reads on this customer, as a shopper deciding whether to buy
would. Weigh whether the colour suits them, whether the cut and proportions work on
their body, and whether the try-on is convincing rather than distorted.

Reply with JSON only: {"quality": <0.0-1.0>, "reason": "<one short sentence>"}

Be honest. A low score is useful — it tells the shop to offer something better."""


class GeminiRenderer:
    """Renders a try-on through the Gemini image models."""

    def __init__(
        self,
        settings: Settings,
        store: PreviewStore,
        client_factory=httpx.AsyncClient,
    ) -> None:
        if not settings.gemini_api_key:
            raise RuntimeError("GeminiRenderer needs GEMINI_API_KEY.")
        self._api_key = settings.gemini_api_key
        self._image_model = settings.gemini_image_model
        self._assess_model = settings.nlu_model
        self._store = store
        self._client_factory = client_factory
        self._timeout = settings.preview_timeout_seconds

    async def render(self, request: GeneratePreviewInput) -> RenderResult:
        async with self._client_factory(timeout=self._timeout) as client:
            customer = await self._fetch_image(client, request.customer_photo_url)
            product = await self._fetch_image(client, request.product.image_url)

            image_bytes, media_type = await self._generate(
                client, customer, product, request.product
            )
            url = await self._store.put(request.request_id, image_bytes, media_type)

            quality, reason = await self._assess(
                client, product, (image_bytes, media_type), request.product
            )

        from codlock_agents.fitting.service import assess

        return RenderResult(image_url=url, match=assess(quality, reason), from_cache=False)

    # -- Gemini ----------------------------------------------------------------------

    async def _generate(
        self,
        client: httpx.AsyncClient,
        customer: tuple[bytes, str],
        product: tuple[bytes, str],
        item: ProductRef,
    ) -> tuple[bytes, str]:
        prompt = RENDER_PROMPT
        described = ", ".join(
            filter(None, [item.name, item.color, f"size {item.size}" if item.size else ""])
        )
        if described:
            prompt = f"{prompt}\n\nThe garment is: {described}."

        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": prompt},
                        _inline(customer),
                        _inline(product),
                    ],
                }
            ]
        }
        body = await self._post(client, self._image_model, payload)

        for part in _parts(body):
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                return (
                    base64.b64decode(inline["data"]),
                    inline.get("mimeType") or inline.get("mime_type") or "image/png",
                )

        # A refusal or a safety block arrives as text where an image should be. Surface
        # it verbatim rather than as a generic failure — it is usually actionable.
        text = " ".join(p.get("text", "") for p in _parts(body)).strip()
        raise RuntimeError(
            f"{self._image_model} returned no image."
            + (f" It said: {text[:300]}" if text else "")
        )

    async def _assess(
        self,
        client: httpx.AsyncClient,
        product: tuple[bytes, str],
        preview: tuple[bytes, str],
        item: ProductRef,
    ) -> tuple[float, str]:
        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": f"{ASSESS_PROMPT}\n\nThe item is a {item.category}: {item.name}."},
                        _inline(product),
                        _inline(preview),
                    ],
                }
            ],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
        }
        try:
            body = await self._post(client, self._assess_model, payload)
            raw = next(p["text"] for p in _parts(body) if p.get("text"))
            parsed = json.loads(raw)
            quality = float(parsed["quality"])
        except Exception as exc:  # noqa: BLE001 - a missing score must not lose the render
            logger.warning("match assessment failed, shipping render anyway: %s", exc)
            return 0.6, "Render succeeded; automatic match assessment was unavailable."

        quality = min(1.0, max(0.0, quality))
        reason = str(parsed.get("reason") or "").strip() or "No reason given."
        return quality, reason

    async def _post(
        self, client: httpx.AsyncClient, model: str, payload: dict
    ) -> dict:
        response = await client.post(
            f"{GEMINI_ENDPOINT}/{model}:generateContent",
            params={"key": self._api_key},
            json=payload,
        )
        if response.status_code != 200:
            raise RuntimeError(
                f"{model} returned {response.status_code}: {response.text[:300]}"
            )
        return response.json()

    # -- inputs ----------------------------------------------------------------------

    @staticmethod
    async def _fetch_image(client: httpx.AsyncClient, url: str) -> tuple[bytes, str]:
        response = await client.get(url, follow_redirects=True)
        if response.status_code != 200:
            raise RuntimeError(f"Could not fetch {url}: HTTP {response.status_code}")

        data = response.content
        if len(data) > MAX_SOURCE_BYTES:
            raise RuntimeError(
                f"{url} is {len(data) // 1024}KB, over the {MAX_SOURCE_BYTES // 1024}KB limit."
            )

        media_type = response.headers.get("content-type", "").split(";")[0].strip()
        if not media_type.startswith("image/"):
            raise RuntimeError(f"{url} is {media_type or 'untyped'}, not an image.")
        return data, media_type


def _inline(image: tuple[bytes, str]) -> dict:
    data, media_type = image
    return {
        "inlineData": {
            "mimeType": media_type,
            "data": base64.b64encode(data).decode("ascii"),
        }
    }


def _parts(body: dict) -> list[dict]:
    candidates = body.get("candidates") or []
    if not candidates:
        return []
    return candidates[0].get("content", {}).get("parts") or []
