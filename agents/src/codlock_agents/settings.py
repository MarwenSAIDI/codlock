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

    # --- mode ---------------------------------------------------------------------
    stub_mode: bool = Field(
        default=True,
        description="True: answer from fixtures, touch no external service. This is "
        "the default so a teammate can clone and run without any credentials.",
    )

    # --- payment agent ------------------------------------------------------------
    payment_host: str = "127.0.0.1"
    payment_port: int = 8101
    payment_public_url: str = "http://127.0.0.1:8101"

    gravv_api_key: str | None = Field(
        default=None, description="grvSec_sandbox_... Without it the MCP loads only "
                                  "its two documentation tools."
    )
    gravv_allow_live_writes: bool = False
    gravv_toolsets: str = "customers,accounts,collections,payment-links,kyc,webhooks"
    gravv_seller_account_id: str | None = Field(
        default=None, description="Destination account for deposits during the demo."
    )
    gravv_source_id: str | None = Field(
        default=None, description="Provider-side source id required by "
                                  "createCardPaymentIntent.source.id."
    )
    settlement_currency: str = Field(
        default="USD",
        description="Gravv holds value in stablecoin and its card collections are "
        "quoted in USD; orders are priced in TND. This is the currency we actually "
        "ask Gravv for. Display currency stays TND end to end.",
    )
    tnd_per_settlement_unit: float = Field(
        default=3.1,
        description="Fallback TND->settlement rate used only when no live FX quote is "
        "available. Approximate on purpose; a real quote overrides it.",
    )

    # --- fitting agent ------------------------------------------------------------
    fitting_host: str = "127.0.0.1"
    fitting_port: int = 8102
    fitting_public_url: str = "http://127.0.0.1:8102"

    image_provider: Literal["stub", "gemini"] = "stub"
    gemini_api_key: str | None = None
    gemini_image_model: str = Field(
        default="gemini-3-pro-image",
        description="Nano Banana Pro. Highest try-on fidelity, which is what is on "
        "screen at the pitch. gemini-3.1-flash-image (Nano Banana 2) is the faster "
        "fallback if renders run long on the day.",
    )
    preview_timeout_seconds: float = 60.0

    supabase_url: str | None = None
    supabase_service_key: str | None = None
    supabase_preview_bucket: str = "previews"

    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    return Settings()
