"""
System overview route — model, BIOS, hostname, health, memory, CPU.
"""

from fastapi import APIRouter, HTTPException
from loguru import logger

from app.services.redfish import redfish_service
from app.utils.response import success_response, error_response
from app.utils.retry import RedfishConnectionError, RedfishRequestError

router = APIRouter(prefix="/system", tags=["System"])


@router.get("")
async def get_system_overview():
    """
    Get full system overview from iDRAC Redfish.
    Returns: model, manufacturer, BIOS, hostname, power state, health, CPU, memory.
    """
    try:
        data = await redfish_service.get_system()
        return success_response(data=data, message="System overview retrieved")
    except RedfishConnectionError as e:
        logger.error(f"System overview failed: {e}")
        raise HTTPException(status_code=503, detail=error_response(
            message="iDRAC unreachable",
            detail=str(e),
            code="IDRAC_UNREACHABLE",
        ))
    except RedfishRequestError as e:
        logger.error(f"System overview Redfish error: {e}")
        raise HTTPException(status_code=e.status_code, detail=error_response(
            message="Redfish request failed",
            detail=e.detail,
            code="REDFISH_ERROR",
        ))
    except Exception as e:
        logger.exception(f"Unexpected error in system overview: {e}")
        raise HTTPException(status_code=500, detail=error_response(
            message="Internal server error",
            detail=str(e),
        ))

@router.get("/memory")
async def get_system_memory():
    """Get detailed memory information."""
    try:
        data = await redfish_service.get_memory()
        return success_response(data=data, message="Memory retrieved")
    except Exception as e:
        logger.exception(f"Memory error: {e}")
        raise HTTPException(status_code=500, detail=error_response(message="Failed", detail=str(e)))

@router.get("/processors")
async def get_system_processors():
    """Get detailed processor information."""
    try:
        data = await redfish_service.get_processors()
        return success_response(data=data, message="Processors retrieved")
    except Exception as e:
        logger.exception(f"Processors error: {e}")
        raise HTTPException(status_code=500, detail=error_response(message="Failed", detail=str(e)))

@router.get("/network")
async def get_system_network():
    """Get detailed network interface information."""
    try:
        data = await redfish_service.get_network()
        return success_response(data=data, message="Network retrieved")
    except Exception as e:
        logger.exception(f"Network error: {e}")
        raise HTTPException(status_code=500, detail=error_response(message="Failed", detail=str(e)))
