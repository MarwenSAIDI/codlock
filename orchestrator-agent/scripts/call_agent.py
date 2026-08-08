#!/usr/bin/env python
"""Call the orchestrator agent from the command line over A2A.

Every CODLOCK agent speaks the same protocol, so this works against the
orchestrator (:8000) as well as the Payment Agent (:8001) and Fitting Agent
(:8002).

    python scripts/call_agent.py 8000 --card
    python scripts/call_agent.py 8000 --text "look up SKU DRESS-BEIGE-001 in size M"
"""

from __future__ import annotations

import asyncio
import json
import sys
import uuid

import httpx

# Mandatory. Without it the server rejects the call as protocol 0.3.
A2A_HEADERS = {"A2A-Version": "1.0"}


async def send(base_url: str, parts: list[dict]) -> dict:
    async with httpx.AsyncClient(base_url=base_url, timeout=90) as client:
        response = await client.post(
            "/",
            headers=A2A_HEADERS,
            json={
                "jsonrpc": "2.0",
                "id": str(uuid.uuid4()),
                "method": "SendMessage",
                "params": {
                    "message": {
                        "messageId": str(uuid.uuid4()),
                        "role": "ROLE_USER",
                        "parts": parts,
                    }
                },
            },
        )
        response.raise_for_status()
        return response.json()


async def call_text(base_url: str, text: str) -> dict:
    """Delegate in natural language, the way a peer ADK agent would."""
    return await send(base_url, [{"text": text}])


async def fetch_card(base_url: str) -> dict:
    async with httpx.AsyncClient(base_url=base_url, timeout=15) as client:
        response = await client.get("/.well-known/agent-card.json")
        response.raise_for_status()
        return response.json()


async def main() -> int:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2

    target = args[0]
    base_url = target if target.startswith("http") else f"http://127.0.0.1:{target}"

    if len(args) > 1 and args[1] == "--card":
        print(json.dumps(await fetch_card(base_url), indent=2))
        return 0

    if len(args) > 2 and args[1] == "--text":
        result = await call_text(base_url, args[2])
    else:
        print(__doc__)
        return 2

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
