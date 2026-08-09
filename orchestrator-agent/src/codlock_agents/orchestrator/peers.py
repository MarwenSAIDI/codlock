"""Calling the peer agents over A2A from plain HTTP handlers.

``google-adk``'s :class:`RemoteA2aAgent` delegates in *natural language*: it needs a
live LLM turn to decide which skill to invoke and to phrase the arguments. That is the
right shape for a conversational request, and the wrong shape for the backend's REST
calls, which already know exactly which skill they want and with which fields.

So the bridge speaks the peers' structured envelope directly — the same A2A transport
the agent uses, with no model in the loop and no extraction step to get wrong::

    request   {"skill": "collect_deposit", "input": {...}}
    response  {"skill": "collect_deposit", "ok": true,  "output": {...}}
              {"skill": "collect_deposit", "ok": false, "error": {"type", "message"}}

The envelope is defined on the peer side in ``fitting-agent/src/codlock_agents/
a2a_support.py`` and mirrored in ``payment-agent/src/router.ts``.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# Mandatory on every call. Without it the peer rejects the request as protocol 0.3.
A2A_HEADERS = {"A2A-Version": "1.0"}

# The peers mount JSON-RPC at the root of their public URL, and their agent cards
# advertise exactly that. Keep the two in step.
RPC_PATH = "/"


class PeerError(RuntimeError):
    """A peer was reachable but refused, or answered something unusable.

    Carries the peer's own error type so the bridge can map it onto an HTTP status
    instead of collapsing every failure into a generic 500.
    """

    def __init__(self, peer: str, skill: str, error_type: str, message: str) -> None:
        super().__init__(f"{peer}.{skill} failed [{error_type}]: {message}")
        self.peer = peer
        self.skill = skill
        self.error_type = error_type
        self.message = message


class PeerNotConfigured(PeerError):
    """The requested peer is absent from A2A_AGENTS, so there is nothing to call."""

    def __init__(self, peer: str, skill: str, known: list[str]) -> None:
        super().__init__(
            peer,
            skill,
            "peer_not_configured",
            f"No peer named {peer!r} in A2A_AGENTS. Configured: "
            f"{', '.join(known) if known else 'none'}.",
        )


def parse_peer_map(raw: str) -> dict[str, str]:
    """Parse ``A2A_AGENTS`` into ``{name: base_url}``.

    Expected format: ``"name=url,name=url"``, e.g.
    ``"payment=http://localhost:8001,fitting=http://localhost:8002"``.
    """
    peers: dict[str, str] = {}
    for entry in filter(None, (e.strip() for e in raw.split(","))):
        name, _, url = entry.partition("=")
        name, url = name.strip(), url.strip()
        if not name or not url:
            raise RuntimeError(f"Invalid A2A_AGENTS entry: {entry!r}")
        peers[name] = url.rstrip("/")
    return peers


class PeerClient:
    """Invokes a named skill on a named peer and returns its ``output`` payload."""

    def __init__(self, peers: dict[str, str], timeout_seconds: float = 30.0) -> None:
        self._peers = peers
        self._timeout = timeout_seconds

    @property
    def names(self) -> list[str]:
        return sorted(self._peers)

    def has(self, peer: str) -> bool:
        return peer in self._peers

    async def call(self, peer: str, skill: str, payload: dict[str, Any]) -> dict[str, Any]:
        base_url = self._peers.get(peer)
        if base_url is None:
            raise PeerNotConfigured(peer, skill, self.names)

        request = {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "SendMessage",  # gRPC-style name; "message/send" is protocol 0.3
            "params": {
                "message": {
                    "messageId": str(uuid.uuid4()),
                    "role": "ROLE_USER",
                    "parts": [{"data": {"skill": skill, "input": payload}}],
                }
            },
        }

        try:
            async with httpx.AsyncClient(base_url=base_url, timeout=self._timeout) as client:
                response = await client.post(RPC_PATH, headers=A2A_HEADERS, json=request)
                response.raise_for_status()
                body = response.json()
        except httpx.HTTPStatusError as exc:
            raise PeerError(
                peer, skill, "http_error", f"HTTP {exc.response.status_code} from {base_url}"
            ) from exc
        except httpx.HTTPError as exc:
            raise PeerError(peer, skill, "unreachable", f"{base_url}: {exc}") from exc
        except ValueError as exc:  # non-JSON body
            raise PeerError(peer, skill, "malformed_response", str(exc)) from exc

        return self._unwrap(peer, skill, body)

    @staticmethod
    def _unwrap(peer: str, skill: str, body: Any) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise PeerError(peer, skill, "malformed_response", "response was not a JSON object")
        if "error" in body:
            raise PeerError(peer, skill, "jsonrpc_error", json.dumps(body["error"]))

        try:
            envelope = body["result"]["message"]["parts"][0]["data"]
        except (KeyError, IndexError, TypeError) as exc:
            raise PeerError(
                peer, skill, "malformed_response", f"no data part in result: {exc}"
            ) from exc

        if not isinstance(envelope, dict):
            raise PeerError(peer, skill, "malformed_response", "data part was not an object")

        # ok=false is a *handled* failure the peer chose to report. Surface its own
        # error type — "invalid_input" and "unreachable" deserve different statuses.
        if not envelope.get("ok", False):
            error = envelope.get("error") or {}
            raise PeerError(
                peer,
                skill,
                str(error.get("type") or "peer_error"),
                str(error.get("message") or "peer reported failure without a message"),
            )

        output = envelope.get("output")
        return output if isinstance(output, dict) else {}


__all__ = ["A2A_HEADERS", "PeerClient", "PeerError", "PeerNotConfigured", "parse_peer_map"]
