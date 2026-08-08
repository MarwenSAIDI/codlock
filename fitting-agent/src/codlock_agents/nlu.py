"""Natural-language fallback for ADK-style delegation.

The orchestrator uses google-adk's ``RemoteA2aAgent``, which delegates by having its
LLM write a sentence rather than a structured envelope. This module turns that sentence
into ``{"skill": ..., "input": {...}}``.

The boundary matters: the model only **transcribes** a request into a shape. What it
produces is validated by the same Pydantic model as any structured call and handed to
the same handler. If it hallucinates a field, validation rejects it and the caller gets
``invalid_input``.
"""

from __future__ import annotations

import json
from typing import Any, Protocol

import httpx

GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models"

INSTRUCTIONS = """You translate a request about a virtual try-on into a single JSON
object. You do not answer the request and you do not invent values.

Reply with exactly: {"skill": "<one of the skills>", "input": { ... }}

Skills and their required inputs:

generate_preview — start rendering the product on the customer's photo.
  request_id          string
  order_id            string
  customer_photo_url  string (url)
  product             { sku, name, image_url, category, color?, size? }

get_preview — poll a render that was already started.
  preview_id          string

Rules:
- Copy values from the request. If a required value is absent, omit the field —
  never guess an id or a URL.
- Output the JSON object only.
"""


class Extractor(Protocol):
    async def extract(self, text: str) -> tuple[str, dict[str, Any]]: ...


class GeminiExtractor:
    """Calls Gemini to transcribe free text into a skill call."""

    def __init__(self, api_key: str, model: str, timeout: float = 30.0) -> None:
        self._api_key = api_key
        self._model = model
        self._timeout = timeout

    async def extract(self, text: str) -> tuple[str, dict[str, Any]]:
        payload = {
            "systemInstruction": {"parts": [{"text": INSTRUCTIONS}]},
            "contents": [{"role": "user", "parts": [{"text": text}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "temperature": 0,
            },
        }
        url = f"{GEMINI_ENDPOINT}/{self._model}:generateContent"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.post(url, params={"key": self._api_key}, json=payload)

        if response.status_code != 200:
            raise RuntimeError(
                f"Gemini returned {response.status_code}: {response.text[:300]}"
            )

        candidates = response.json().get("candidates") or []
        try:
            raw = candidates[0]["content"]["parts"][0]["text"]
        except (IndexError, KeyError) as exc:
            raise RuntimeError("Gemini returned no candidate text.") from exc

        parsed = json.loads(raw)
        skill = parsed.get("skill")
        if not isinstance(skill, str):
            raise RuntimeError(f"Extraction has no skill: {raw[:200]}")
        return skill, parsed.get("input") or {}


class UnavailableExtractor:
    """Used when no Gemini key is configured. Refuses rather than guessing."""

    async def extract(self, text: str) -> tuple[str, dict[str, Any]]:
        raise RuntimeError(
            "A plain-text request arrived but natural-language extraction is not "
            "configured. Set GEMINI_API_KEY, or send a structured "
            '{"skill", "input"} data part.'
        )
