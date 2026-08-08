"""Where a rendered preview goes so the customer's chat can show it.

Supabase Storage is the target — the same project the rest of the pipeline reads from.
Until those credentials exist, previews land on local disk and are served by the agent
itself, so the whole path is testable today rather than blocked on a teammate.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Protocol

import httpx

logger = logging.getLogger(__name__)

EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


class PreviewStore(Protocol):
    async def put(self, key: str, data: bytes, media_type: str) -> str:
        """Store the image and return a URL a chat client can load."""
        ...


class LocalPreviewStore:
    """Writes under ``previews/`` and returns a URL served by this agent.

    Good enough for the demo and for development. It is not durable: the directory is
    gitignored and a redeploy loses it.
    """

    def __init__(self, directory: Path, public_url: str) -> None:
        self._directory = directory
        self._public_url = public_url.rstrip("/")
        self._directory.mkdir(parents=True, exist_ok=True)

    async def put(self, key: str, data: bytes, media_type: str) -> str:
        filename = f"{key}{EXTENSIONS.get(media_type, '.png')}"
        (self._directory / filename).write_bytes(data)
        return f"{self._public_url}/previews/{filename}"


class SupabasePreviewStore:
    """Uploads to Supabase Storage and returns the public object URL."""

    def __init__(self, url: str, service_key: str, bucket: str) -> None:
        self._base = url.rstrip("/")
        self._key = service_key
        self._bucket = bucket

    async def put(self, key: str, data: bytes, media_type: str) -> str:
        filename = f"{key}{EXTENSIONS.get(media_type, '.png')}"
        endpoint = f"{self._base}/storage/v1/object/{self._bucket}/{filename}"
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                endpoint,
                content=data,
                headers={
                    "Authorization": f"Bearer {self._key}",
                    "Content-Type": media_type,
                    # Re-rendering the same request_id should replace, not 409.
                    "x-upsert": "true",
                },
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Supabase upload failed {response.status_code}: {response.text[:300]}"
            )
        return f"{self._base}/storage/v1/object/public/{self._bucket}/{filename}"
