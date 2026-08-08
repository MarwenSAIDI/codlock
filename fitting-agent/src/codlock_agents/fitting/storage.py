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


def normalise_project_url(url: str) -> str:
    """Reduce whatever was pasted to the project origin.

    The Supabase dashboard shows the REST endpoint, so people copy
    ``https://<ref>.supabase.co/rest/v1/``. Storage lives at ``/storage/v1``, a sibling
    of ``/rest/v1`` rather than a child, so the suffix has to come off or every upload
    404s in a way that looks like a missing bucket.
    """
    trimmed = url.strip().rstrip("/")
    for suffix in ("/rest/v1", "/storage/v1", "/auth/v1"):
        if trimmed.endswith(suffix):
            trimmed = trimmed[: -len(suffix)]
    return trimmed


class SupabasePreviewStore:
    """Uploads to Supabase Storage and returns the public object URL."""

    def __init__(
        self,
        url: str,
        service_key: str,
        bucket: str,
        client_factory=httpx.AsyncClient,
    ) -> None:
        if service_key.startswith(("sb_publishable_", "sbp_")):
            raise RuntimeError(
                "SUPABASE_SERVICE_KEY looks like a publishable (anon) key. Uploads run "
                "server-side and are blocked by row-level security with that key — you "
                "need the secret/service_role key from Settings > API Keys. Leave it "
                "blank to store previews locally instead."
            )
        self._base = normalise_project_url(url)
        self._key = service_key
        self._bucket = bucket
        self._client_factory = client_factory

    def _headers(self, **extra: str) -> dict[str, str]:
        """Both headers, always.

        The newer ``sb_secret_`` keys are not JWTs. Sending only
        ``Authorization: Bearer`` makes Supabase try to parse one and fail with
        "Invalid Compact JWS", which reads like a bad key rather than a missing header.
        """
        return {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            **extra,
        }

    async def ensure_bucket(self) -> None:
        """Create the bucket if it is missing. A fresh project has none."""
        async with self._client_factory(timeout=30) as client:
            response = await client.post(
                f"{self._base}/storage/v1/bucket",
                headers=self._headers(**{"Content-Type": "application/json"}),
                json={"id": self._bucket, "name": self._bucket, "public": True},
            )
        # 409 / "already exists" is the happy path on every run after the first.
        if response.status_code >= 400 and "exist" not in response.text.lower():
            logger.warning(
                "could not ensure bucket %r: %s %s",
                self._bucket, response.status_code, response.text[:200],
            )

    async def put(self, key: str, data: bytes, media_type: str) -> str:
        filename = f"{key}{EXTENSIONS.get(media_type, '.png')}"
        endpoint = f"{self._base}/storage/v1/object/{self._bucket}/{filename}"
        async with self._client_factory(timeout=60) as client:
            response = await client.post(
                endpoint,
                content=data,
                headers=self._headers(**{
                    "Content-Type": media_type,
                    # Re-rendering the same request_id should replace, not 409.
                    "x-upsert": "true",
                }),
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Supabase upload failed {response.status_code}: {response.text[:300]}"
            )
        return f"{self._base}/storage/v1/object/public/{self._bucket}/{filename}"
