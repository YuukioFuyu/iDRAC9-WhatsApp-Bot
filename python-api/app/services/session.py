"""
Redfish Session Manager — handles X-Auth-Token lifecycle for iDRAC 9.

Key responsibilities:
- Create Redfish sessions via POST /redfish/v1/Sessions
- Cache and auto-refresh X-Auth-Token
- Cleanup sessions on shutdown (DELETE session URI)
- Thread-safe (asyncio.Lock) to prevent concurrent session creation
"""

import asyncio
import time
from typing import Optional
from loguru import logger
import httpx

from app.config import settings


class SessionManager:
    """Manages iDRAC Redfish session tokens with automatic refresh."""

    def __init__(self, client: httpx.AsyncClient):
        self._client = client
        self._token: Optional[str] = None
        self._session_uri: Optional[str] = None
        self._created_at: float = 0
        self._lock = asyncio.Lock()

    @property
    def token(self) -> Optional[str]:
        """Current session token (may be expired)."""
        return self._token

    @property
    def is_valid(self) -> bool:
        """Check if the session is likely still valid based on TTL."""
        if not self._token:
            return False
        elapsed = time.time() - self._created_at
        # Refresh before actual expiry (90% of TTL)
        return elapsed < (settings.idrac_session_ttl * 0.9)

    async def ensure_session(self) -> str:
        """
        Ensure we have a valid session token.
        Creates a new session if needed. Thread-safe.
        Returns the X-Auth-Token string.
        """
        if self.is_valid:
            return self._token

        async with self._lock:
            # Double-check after acquiring lock
            if self.is_valid:
                return self._token

            # Try to validate existing token first
            if self._token:
                try:
                    resp = await self._client.get(
                        "/redfish/v1/Systems",
                        headers={"X-Auth-Token": self._token},
                    )
                    if resp.status_code != 401:
                        self._created_at = time.time()
                        logger.debug("Existing Redfish session still valid")
                        return self._token
                except Exception:
                    pass

            # Create new session
            return await self._create_session()

    async def _create_session(self) -> str:
        """Create a new Redfish session."""
        logger.info("Creating new Redfish session...")

        try:
            resp = await self._client.post(
                "/redfish/v1/Sessions",
                json={
                    "UserName": settings.idrac_username,
                    "Password": settings.idrac_password,
                },
            )
            resp.raise_for_status()
        except httpx.ConnectError:
            logger.error(f"Cannot connect to iDRAC at {settings.idrac_host}")
            raise
        except httpx.HTTPStatusError as e:
            logger.error(f"Redfish session creation failed: {e.response.status_code}")
            raise

        self._token = resp.headers.get("X-Auth-Token")
        self._session_uri = resp.headers.get("Location")
        self._created_at = time.time()

        if not self._token:
            raise RuntimeError("iDRAC did not return X-Auth-Token header")

        logger.info(
            f"Redfish session created (URI: {self._session_uri}, "
            f"TTL: {settings.idrac_session_ttl}s)"
        )
        return self._token

    def invalidate(self) -> None:
        """Mark current session as invalid (e.g., after 401 response)."""
        logger.warning("Invalidating current Redfish session")
        self._token = None
        self._created_at = 0

    async def close(self) -> None:
        """Delete the Redfish session to free iDRAC session slots."""
        if self._session_uri and self._token:
            try:
                await self._client.delete(
                    self._session_uri,
                    headers={"X-Auth-Token": self._token},
                )
                logger.info(f"Redfish session deleted: {self._session_uri}")
            except Exception as e:
                logger.warning(f"Failed to delete Redfish session: {e}")
            finally:
                self._token = None
                self._session_uri = None
                self._created_at = 0
