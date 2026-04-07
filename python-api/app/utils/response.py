"""
Unified response formatter for consistent API output.
"""

from typing import Any, Optional
from datetime import datetime, timezone


def success_response(
    data: Any = None,
    message: str = "OK",
    meta: Optional[dict] = None,
) -> dict:
    """Format a successful API response."""
    response = {
        "success": True,
        "message": message,
        "data": data,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if meta:
        response["meta"] = meta
    return response


def error_response(
    message: str = "An error occurred",
    detail: Optional[str] = None,
    code: Optional[str] = None,
) -> dict:
    """Format an error API response."""
    response = {
        "success": False,
        "message": message,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if detail:
        response["detail"] = detail
    if code:
        response["code"] = code
    return response
