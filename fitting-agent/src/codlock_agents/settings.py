"""Runtime configuration. Every secret comes from the environment, never a file in git."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    stub_mode: bool = Field(
        default=True,
        description="True: answer from fixtures, touch no external service. Default so "
        "a teammate can clone and run without any credentials.",
    )
    log_level: str = "INFO"

    fitting_host: str = "127.0.0.1"
    fitting_port: int = 8002
    fitting_public_url: str = "http://127.0.0.1:8002"

    image_provider: Literal["stub", "gemini"] = "stub"
    gemini_api_key: str | None = None
    gemini_image_model: str = Field(
        default="gemini-3-pro-image",
        description="Nano Banana Pro. Highest try-on fidelity, which is what is on "
        "screen at the pitch. gemini-3.1-flash-image (Nano Banana 2) is the faster "
        "fallback if renders run long on the day.",
    )
    nlu_model: str = Field(
        default="gemini-flash-latest",
        description="Used only to turn an ADK plain-text delegation into a validated "
        "skill call. It never chooses what to render.",
    )
    preview_timeout_seconds: float = 60.0

    supabase_url: str | None = None
    supabase_service_key: str | None = None
    supabase_preview_bucket: str = "previews"


@lru_cache
def get_settings() -> Settings:
    return Settings()
