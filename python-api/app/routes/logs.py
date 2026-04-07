"""
System Event Log (SEL) routes — iDRAC log entries.
"""

from fastapi import APIRouter, HTTPException, Query
from loguru import logger

from app.services.redfish import redfish_service
from app.utils.response import success_response, error_response
from app.utils.retry import RedfishConnectionError

router = APIRouter(prefix="/logs", tags=["Logs"])


@router.get("")
async def get_logs(
    limit: int = Query(
        default=50,
        ge=1,
        le=500,
        description="Maximum number of log entries to return",
    ),
):
    """
    Get System Event Log (SEL) entries from iDRAC.
    Ordered by most recent first.
    """
    try:
        data = await redfish_service.get_sel_entries(limit=limit)
        return success_response(data=data, message="SEL entries retrieved")
    except RedfishConnectionError:
        raise HTTPException(status_code=503, detail=error_response(
            message="iDRAC unreachable", code="IDRAC_UNREACHABLE",
        ))
    except Exception as e:
        logger.exception(f"SEL entries error: {e}")
        raise HTTPException(status_code=500, detail=error_response(
            message="Failed to get log entries", detail=str(e),
        ))


@router.get("/latest")
async def get_latest_logs(
    count: int = Query(
        default=5,
        ge=1,
        le=50,
        description="Number of latest entries to return",
    ),
):
    """
    Get the latest N log entries.
    Optimized for alert diffing (smaller payload, shorter cache TTL).
    """
    try:
        data = await redfish_service.get_sel_latest(count=count)
        return success_response(data=data, message="Latest SEL entries retrieved")
    except RedfishConnectionError:
        raise HTTPException(status_code=503, detail=error_response(
            message="iDRAC unreachable", code="IDRAC_UNREACHABLE",
        ))
    except Exception as e:
        logger.exception(f"Latest SEL error: {e}")
        raise HTTPException(status_code=500, detail=error_response(
            message="Failed to get latest log entries", detail=str(e),
        ))
