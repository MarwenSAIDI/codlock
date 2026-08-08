#!/usr/bin/env python
"""Call a skill on a running CODLOCK agent from the command line.

For the orchestrator owner: this is the smallest complete example of what your code
has to send. Copy the request shape out of :func:`call`.

    python scripts/call_agent.py 8001 collect_deposit '{"order_id": "ord_1", ...}'
    python scripts/call_agent.py 8002 generate_preview @sample_preview.json
    python scripts/call_agent.py 8001 --card
"""

from __future__ import annotations

import asyncio
import json
import sys
import uuid
from pathlib import Path

import httpx

A2A_VERSION_HEADER = {"A2A-Version": "1.0"}


async def call(base_url: str, skill: str, payload: dict) -> dict:
    async with httpx.AsyncClient(base_url=base_url, timeout=60) as client:
        response = await client.post(
            "/",
            headers=A2A_VERSION_HEADER,
            json={
                "jsonrpc": "2.0",
                "id": str(uuid.uuid4()),
                "method": "SendMessage",
                "params": {
                    "message": {
                        "messageId": str(uuid.uuid4()),
                        "role": "ROLE_USER",
                        "parts": [{"data": {"skill": skill, "input": payload}}],
                    }
                },
            },
        )
        response.raise_for_status()
        body = response.json()
    if "error" in body:
        return body
    return body["result"]["message"]["parts"][0]["data"]


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

    port = args[0]
    base_url = port if port.startswith("http") else f"http://127.0.0.1:{port}"

    if len(args) > 1 and args[1] == "--card":
        print(json.dumps(await fetch_card(base_url), indent=2))
        return 0

    if len(args) < 2:
        print(__doc__)
        return 2

    skill = args[1]
    payload = _load(args[2]) if len(args) > 2 else {}
    result = await call(base_url, skill, payload)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
