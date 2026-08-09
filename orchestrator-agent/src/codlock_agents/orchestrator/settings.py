"""Runtime configuration. Every secret comes from the environment, never a file in git."""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    log_level: str = "INFO"

    orchestrator_host: str = "127.0.0.1"
    orchestrator_port: int = 8000
    orchestrator_public_url: str = "http://127.0.0.1:8000"

    # LiteLLM-style model id, e.g. "openai/gpt-4o" or "anthropic/claude-sonnet-5".
    model_name: str = Field(description="LiteLLM model id used by the root agent.")
    model_api_url: str = Field(description="Base URL of the model's OpenAI-compatible API.")
    model_api_key: str = Field(description="API key for the model endpoint.")

    a2a_agents: str = Field(
        default="",
        description="Peer agents to discover over A2A, as 'name=url' pairs separated by "
        "commas, e.g. 'payment=http://localhost:8001,fitting=http://localhost:8002'. "
        "Each agent's card is resolved lazily, on first delegation.",
    )

    supabase_url: str = Field(description="Supabase project URL backing internal tools.")
    supabase_key: str = Field(
        description="Supabase service-role (or other server-side) key. Never the "
        "anon/public key used by clients."
    )

    # ── REST bridge (the /agent/* routes the NestJS backend calls) ──
    peer_call_timeout_seconds: float = Field(
        default=30.0,
        description="Per-call timeout when invoking a peer agent's skill over A2A.",
    )
    preview_timeout_seconds: float = Field(
        default=90.0,
        description="How long the bridge polls a try-on render before answering 504. "
        "Must exceed the Fitting Agent's own PREVIEW_TIMEOUT_SECONDS, and stay under "
        "the backend's ORCHESTRATOR_TIMEOUT_MS or the backend gives up first.",
    )
    preview_poll_interval_seconds: float = Field(
        default=2.0, description="Delay between get_preview polls while a render runs."
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
