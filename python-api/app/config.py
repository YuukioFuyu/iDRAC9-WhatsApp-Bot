"""
Configuration module — loads and validates environment variables via Pydantic Settings.
"""

from pydantic_settings import BaseSettings
from pydantic import Field
from typing import Optional


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # ── iDRAC / Redfish ─────────────────────────
    idrac_host: str = Field(
        default="https://192.168.1.100",
        description="iDRAC base URL (https://ip-or-hostname)"
    )
    idrac_username: str = Field(default="root")
    idrac_password: str = Field(default="calvin")
    idrac_verify_ssl: bool = Field(
        default=False,
        description="Verify iDRAC SSL certificate (False for self-signed)"
    )
    idrac_timeout: int = Field(
        default=30,
        description="HTTP timeout in seconds for Redfish requests"
    )
    idrac_session_ttl: int = Field(
        default=1800,
        description="Redfish session time-to-live in seconds (default 30min)"
    )

    # ── Python API ──────────────────────────────
    py_api_host: str = Field(default="0.0.0.0")
    py_api_port: int = Field(default=8000)

    # ── Redis (optional) ────────────────────────
    redis_enabled: bool = Field(default=False)
    redis_host: str = Field(default="redis")
    redis_port: int = Field(default=6379)
    redis_username: Optional[str] = Field(default=None)
    redis_password: Optional[str] = Field(default=None)
    redis_db: int = Field(default=0)
    redis_prefix: str = Field(
        default="idrac:",
        description="Key prefix for all Redis keys (namespace isolation)"
    )

    # ── Logging ─────────────────────────────────
    log_level: str = Field(default="info")

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "case_sensitive": False,
        "extra": "ignore",  # Ignore unknown env vars (Node.js vars etc.)
    }


# Singleton instance
settings = Settings()
