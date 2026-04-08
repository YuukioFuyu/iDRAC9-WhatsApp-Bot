"""
Thermal monitoring routes — temperatures and fan speeds.
"""

from fastapi import APIRouter, HTTPException
from loguru import logger

from app.services.redfish import redfish_service
from app.utils.response import success_response, error_response
from app.utils.retry import RedfishConnectionError

router = APIRouter(prefix="/thermal", tags=["Thermal"])


@router.get("")
async def get_thermal():
    """
    Get thermal data from iDRAC: temperature sensors and fan speeds.
    Only returns sensors in 'Enabled' state.
    """
    try:
        data = await redfish_service.get_thermal()
        return success_response(data=data, message="Thermal data retrieved")
    except RedfishConnectionError:
        raise HTTPException(status_code=503, detail=error_response(
            message="iDRAC unreachable", code="IDRAC_UNREACHABLE",
        ))
    except Exception as e:
        logger.exception(f"Thermal data error: {e}")
        raise HTTPException(status_code=500, detail=error_response(
            message="Failed to get thermal data", detail=str(e),
        ))
