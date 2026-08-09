"""Preview storage: the local fallback, and the Supabase footguns."""

from __future__ import annotations

import httpx
import pytest

from codlock_agents.fitting.storage import (
    LocalPreviewStore,
    SupabasePreviewStore,
    normalise_project_url,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"bytes"


async def test_local_store_writes_and_returns_a_loadable_url(tmp_path):
    store = LocalPreviewStore(tmp_path, "http://fitting.test/")
    url = await store.put("req_1", PNG, "image/png")

    assert url == "http://fitting.test/previews/req_1.png"
    assert (tmp_path / "req_1.png").read_bytes() == PNG


async def test_local_store_matches_the_extension_to_the_media_type(tmp_path):
    store = LocalPreviewStore(tmp_path, "http://fitting.test")
    assert (await store.put("a", PNG, "image/jpeg")).endswith(".jpg")
    assert (await store.put("b", PNG, "image/webp")).endswith(".webp")
    # An unfamiliar type still lands somewhere loadable rather than extensionless.
    assert (await store.put("c", PNG, "image/avif")).endswith(".png")


@pytest.mark.parametrize(
    "given",
    [
        "https://ref.supabase.co",
        "https://ref.supabase.co/",
        # What the dashboard actually shows, and what people paste.
        "https://ref.supabase.co/rest/v1/",
        "https://ref.supabase.co/storage/v1",
    ],
)
def test_project_url_is_reduced_to_the_origin(given):
    assert normalise_project_url(given) == "https://ref.supabase.co"


def test_a_publishable_key_is_refused_with_an_actionable_message():
    # Row-level security blocks server-side writes with an anon key, and the resulting
    # error reads as "bucket not found", which sends you hunting the wrong problem.
    with pytest.raises(RuntimeError, match="secret/service_role"):
        SupabasePreviewStore(
            "https://ref.supabase.co", "sb_publishable_abc123", "previews"
        )


async def test_supabase_upload_targets_the_storage_path_and_upserts():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["upsert"] = request.headers.get("x-upsert")
        seen["auth"] = request.headers.get("authorization")
        seen["apikey"] = request.headers.get("apikey")
        return httpx.Response(200, json={"Key": "previews/req_1.png"})

    def factory(**kwargs):
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), **kwargs)

    store = SupabasePreviewStore(
        # Pasted straight from the dashboard, REST suffix and all.
        "https://ref.supabase.co/rest/v1/", "sb_secret_xyz", "previews", factory
    )
    url = await store.put("req_1", PNG, "image/png")

    assert seen["url"] == "https://ref.supabase.co/storage/v1/object/previews/req_1.png"
    # Re-rendering the same request_id must replace, not 409.
    assert seen["upsert"] == "true"
    assert seen["auth"] == "Bearer sb_secret_xyz"
    # sb_secret_ keys are not JWTs; without apikey Supabase answers
    # "Invalid Compact JWS", which reads like a bad key rather than a missing header.
    assert seen["apikey"] == "sb_secret_xyz"
    assert url == (
        "https://ref.supabase.co/storage/v1/object/public/previews/req_1.png"
    )
