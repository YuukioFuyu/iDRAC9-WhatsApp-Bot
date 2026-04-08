"""
Retry utilities using Tenacity for resilient Redfish API calls.
"""

from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
    before_sleep_log,
)
from loguru import logger
import httpx


# ── Retry decorator for Redfish requests ────────────────
# - Max 3 attempts
# - Exponential backoff: 1s → 2s → 4s
# - Only retry on network/timeout errors and 5xx responses

redfish_retry = retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    retry=retry_if_exception_type((
        httpx.ConnectError,
        httpx.TimeoutException,
        httpx.ReadTimeout,
        ConnectionError,
    )),
    before_sleep=before_sleep_log(logger, "WARNING"),
    reraise=True,
)


class RedfishSessionExpired(Exception):
    """Raised when iDRAC Redfish session token is invalid/expired (401)."""
    pass


class RedfishConnectionError(Exception):
    """Raised when iDRAC is unreachable."""
    pass


class RedfishRequestError(Exception):
    """Raised when iDRAC returns an unexpected error."""
    def __init__(self, status_code: int, detail: str = ""):
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"Redfish error {status_code}: {detail}")
