"""Thin shared layer over the A2A SDK.

a2a-sdk 1.x models its wire types as **protobuf** messages, not Pydantic. That is a
sharp edge: our contract in :mod:`codlock_agents.schemas` is Pydantic, so every
request crossing the boundary has to be translated twice. This module is where that
translation lives, so no handler ever touches protobuf directly.

Envelope, both directions, carried in a single ``Part.data``::

    request   {"skill": "collect_deposit", "input": {...}}
    response  {"skill": "collect_deposit", "ok": true,  "output": {...}}
              {"skill": "collect_deposit", "ok": false, "error": {"type": ..., "message": ...}}

Why an explicit envelope rather than A2A's native task semantics: the orchestrator is
being written by someone else, in parallel, against a deadline. One obvious shape they
can branch on beats a protocol they have to learn.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.types import Message, Part, Role
from google.protobuf import json_format
from google.protobuf.struct_pb2 import Value
from pydantic import BaseModel, ValidationError

logger = logging.getLogger(__name__)

TIn = TypeVar("TIn", bound=BaseModel)
TOut = TypeVar("TOut", bound=BaseModel)

Handler = Callable[[BaseModel], Awaitable[BaseModel]]


# --------------------------------------------------------------------------------------
# protobuf <-> python
# --------------------------------------------------------------------------------------


def to_value(payload: dict[str, Any]) -> Value:
    value = Value()
    json_format.ParseDict(payload, value)
    return value


def from_value(value: Value) -> dict[str, Any]:
    parsed = json_format.MessageToDict(value, preserving_proto_field_name=True)
    return parsed if isinstance(parsed, dict) else {}


def data_message(
    payload: dict[str, Any],
    *,
    context_id: str = "",
    task_id: str = "",
) -> Message:
    """Build an agent-role Message carrying one structured data part."""
    return Message(
        message_id=str(uuid.uuid4()),
        role=Role.ROLE_AGENT,
        parts=[Part(data=to_value(payload))],
        context_id=context_id,
        task_id=task_id,
    )


def read_envelope(message: Message) -> dict[str, Any]:
    """Pull the request envelope out of the first data part.

    Falls back to a text part holding JSON, because a hand-written curl during
    integration should not have to construct protobuf Values correctly.
    """
    for part in message.parts:
        if part.HasField("data"):
            return from_value(part.data)
    for part in message.parts:
        if part.text:
            import json

            try:
                loaded = json.loads(part.text)
            except ValueError:
                continue
            if isinstance(loaded, dict):
                return loaded
    return {}


# --------------------------------------------------------------------------------------
# skill routing
# --------------------------------------------------------------------------------------


class SkillRouter:
    """Maps a skill name to its input model and handler."""

    def __init__(self) -> None:
        self._routes: dict[str, tuple[type[BaseModel], Handler]] = {}

    def register(
        self, name: str, input_model: type[TIn]
    ) -> Callable[[Callable[[TIn], Awaitable[TOut]]], Callable[[TIn], Awaitable[TOut]]]:
        def decorate(fn: Callable[[TIn], Awaitable[TOut]]):
            self._routes[name] = (input_model, fn)  # type: ignore[assignment]
            return fn

        return decorate

    @property
    def skills(self) -> list[str]:
        return sorted(self._routes)

    async def dispatch(self, skill: str, raw_input: dict[str, Any]) -> dict[str, Any]:
        route = self._routes.get(skill)
        if route is None:
            return _error(skill, "unknown_skill",
                          f"No skill {skill!r}. Known: {', '.join(self.skills)}.")
        input_model, handler = route
        try:
            parsed = input_model.model_validate(raw_input)
        except ValidationError as exc:
            return _error(skill, "invalid_input", exc.json())
        try:
            result = await handler(parsed)
        except Exception as exc:  # noqa: BLE001 - the boundary is where we stop the bleed
            logger.exception("skill %s failed", skill)
            return _error(skill, type(exc).__name__, str(exc))
        return {"skill": skill, "ok": True, "output": result.model_dump(mode="json")}


def _error(skill: str, err_type: str, message: str) -> dict[str, Any]:
    return {"skill": skill, "ok": False,
            "error": {"type": err_type, "message": message}}


class RoutedAgentExecutor(AgentExecutor):
    """Adapts a :class:`SkillRouter` to the A2A executor interface."""

    def __init__(self, router: SkillRouter) -> None:
        self._router = router

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        envelope = read_envelope(context.message) if context.message else {}
        skill = envelope.get("skill", "")
        payload = envelope.get("input") or {}

        if not skill:
            response = _error("", "missing_skill",
                              "Envelope needs a 'skill' key. Known: "
                              f"{', '.join(self._router.skills)}.")
        else:
            response = await self._router.dispatch(skill, payload)

        await event_queue.enqueue_event(
            data_message(
                response,
                context_id=context.context_id or "",
                task_id=context.task_id or "",
            )
        )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        await event_queue.enqueue_event(
            data_message(
                _error("", "not_cancelable", "These skills run to completion."),
                context_id=context.context_id or "",
                task_id=context.task_id or "",
            )
        )
