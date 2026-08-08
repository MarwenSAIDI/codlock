#!/usr/bin/env python
"""Run one real try-on render and write the result to disk.

The point of this script is to look at the output with your own eyes before the pitch.
Tests prove the plumbing; only a human can tell you whether the render is convincing.

    # with your own assets (the way you should run it before Sunday)
    uv run python scripts/smoke_render.py --customer photo.jpg --product dress.jpg

    # with nothing at all — generates stand-in source images first
    uv run python scripts/smoke_render.py

Local files are served over a temporary HTTP server so the real fetch path is exercised,
not bypassed. Needs GEMINI_API_KEY.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import functools
import http.server
import socket
import socketserver
import sys
import threading
from pathlib import Path

import httpx

from codlock_agents.fitting.gemini_renderer import GEMINI_ENDPOINT, GeminiRenderer
from codlock_agents.fitting.storage import LocalPreviewStore
from codlock_agents.schemas import GeneratePreviewInput, ProductRef
from codlock_agents.settings import get_settings

OUT = Path("previews")

STAND_INS = {
    "customer.png": (
        "A full-length candid photograph of a woman in her late twenties standing "
        "in a plain living room, wearing a plain white t-shirt and blue jeans, "
        "facing the camera, natural window light from the left, shot on a phone."
    ),
    "product.png": (
        "An e-commerce catalogue photograph of a beige short-sleeved summer dress "
        "on a wooden hanger against a plain white wall, soft even studio lighting."
    ),
}


def serve_directory(directory: Path) -> tuple[str, socketserver.TCPServer]:
    """Serve `directory` on a free port so the renderer can fetch by URL."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]

    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(directory)
    )
    handler.log_message = lambda *args, **kwargs: None  # type: ignore[assignment]
    server = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}", server


async def generate_stand_in(api_key: str, model: str, prompt: str, target: Path) -> None:
    print(f"  generating {target.name} ...", flush=True)
    async with httpx.AsyncClient(timeout=180) as client:
        response = await client.post(
            f"{GEMINI_ENDPOINT}/{model}:generateContent",
            params={"key": api_key},
            json={"contents": [{"role": "user", "parts": [{"text": prompt}]}]},
        )
    response.raise_for_status()
    for part in response.json()["candidates"][0]["content"]["parts"]:
        inline = part.get("inlineData") or part.get("inline_data")
        if inline and inline.get("data"):
            target.write_bytes(base64.b64decode(inline["data"]))
            return
    raise SystemExit(f"Could not generate {target.name}: no image in the response.")


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--customer", help="Path or URL to the customer photo.")
    parser.add_argument("--product", help="Path or URL to the catalogue photo.")
    parser.add_argument("--name", default="Beige Summer Dress")
    parser.add_argument("--category", default="dress")
    parser.add_argument("--color", default="beige")
    parser.add_argument("--size", default="M")
    args = parser.parse_args()

    settings = get_settings()
    if not settings.gemini_api_key:
        raise SystemExit("GEMINI_API_KEY is not set. Put it in fitting-agent/.env.")

    OUT.mkdir(parents=True, exist_ok=True)
    sources = OUT / "_sources"
    sources.mkdir(exist_ok=True)

    base_url, server = serve_directory(sources)
    try:
        if args.customer and args.product:
            urls = []
            for label, given in (("customer", args.customer), ("product", args.product)):
                if given.startswith("http"):
                    urls.append(given)
                else:
                    source = Path(given)
                    if not source.exists():
                        raise SystemExit(f"No such file: {source}")
                    copy = sources / f"{label}{source.suffix}"
                    copy.write_bytes(source.read_bytes())
                    urls.append(f"{base_url}/{copy.name}")
            customer_url, product_url = urls
        else:
            print("No assets given — generating stand-ins with Gemini.")
            print("Re-run with --customer and --product once you have real photos.\n")
            for filename, prompt in STAND_INS.items():
                await generate_stand_in(
                    settings.gemini_api_key, settings.gemini_image_model,
                    prompt, sources / filename,
                )
            customer_url = f"{base_url}/customer.png"
            product_url = f"{base_url}/product.png"

        request = GeneratePreviewInput(
            request_id="smoke_render",
            order_id="ord_smoke",
            customer_photo_url=customer_url,
            product=ProductRef(
                sku="SMOKE-001", name=args.name, image_url=product_url,
                category=args.category, color=args.color, size=args.size,
            ),
        )

        print(f"\nRendering with {settings.gemini_image_model} ...", flush=True)
        renderer = GeminiRenderer(
            settings, LocalPreviewStore(OUT, settings.fitting_public_url)
        )
        result = await renderer.render(request)
    finally:
        server.shutdown()

    print("\n--- render complete ---")
    print(f"  url      {result.image_url}")
    print(f"  quality  {result.match.quality:.2f}  ({result.match.verdict.value})")
    print(f"  reason   {result.match.reason}")
    print(f"  offer an alternative? {result.match.recommend_alternative}")
    print(f"\nOpen {OUT / 'smoke_render.png'} and judge it yourself.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
