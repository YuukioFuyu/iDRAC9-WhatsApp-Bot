"""
Storage routes — disk drives, RAID controllers, volumes.
"""

from fastapi import APIRouter, HTTPException
from loguru import logger

from app.services.redfish import redfish_service
from app.utils.response import success_response, error_response
from app.utils.retry import RedfishConnectionError

router = APIRouter(prefix="/storage", tags=["Storage"])


@router.get("")
async def get_storage():
    """
    Get storage overview: controllers and physical drives.
    Includes capacity, media type, protocol, and health status.
    """
    try:
        data = await redfish_service.get_storage()
        return success_response(data=data, message="Storage data retrieved")
    except RedfishConnectionError:
        raise HTTPException(status_code=503, detail=error_response(
            message="iDRAC unreachable", code="IDRAC_UNREACHABLE",
        ))
    except Exception as e:
        logger.exception(f"Storage data error: {e}")
        raise HTTPException(status_code=500, detail=error_response(
            message="Failed to get storage data", detail=str(e),
        ))
