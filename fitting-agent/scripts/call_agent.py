#!/usr/bin/env python
"""Call a skill on any CODLOCK agent from the command line.

Both agents speak the same protocol, so this works against the Python Fitting Agent
(:8002) and the TypeScript Payment Agent (:8001) alike.

For the orchestrator owner: this is the smallest complete example of what your code
has to send. Copy the request shape out of :func:`call`.

    python scripts/call_agent.py 8002 generate_preview '{"request_id": "req_1", ...}'
    python scripts/call_agent.py 8001 collect_deposit @order.json
    python scripts/call_agent.py 8001 --card
    python scripts/call_agent.py 8002 --text "try the beige dress on her"
"""

from __future__ import annotations

import asyncio
import json
import sys
import uuid
from pathlib import Path

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
        body = response.json()
    if "error" in body:
        return body
    return body["result"]["message"]["parts"][0]["data"]


async def call(base_url: str, skill: str, payload: dict) -> dict:
    return await send(base_url, [{"data": {"skill": skill, "input": payload}}])


async def call_text(base_url: str, text: str) -> dict:
    """The plain-text path, the way google-adk's RemoteA2aAgent delegates."""
    return await send(base_url, [{"text": text}])


async def fetch_card(base_url: str) -> dict:
    async with httpx.AsyncClient(base_url=base_url, timeout=15) as client:
        response = await client.get("/.well-known/agent-card.json")
        response.raise_for_status()
        return response.json()


def _load(arg: str) -> dict:
    if arg.startswith("@"):
        return json.loads(Path(arg[1:]).read_text(encoding="utf-8"))
    return json.loads(arg)


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
    elif len(args) > 1:
        result = await call(base_url, args[1], _load(args[2]) if len(args) > 2 else {})
    else:
        print(__doc__)
        return 2

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
