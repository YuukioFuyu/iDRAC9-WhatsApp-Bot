"""
Power management routes — state query + control actions.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Literal
from loguru import logger

from app.services.redfish import redfish_service
from app.utils.response import success_response, error_response
from app.utils.retry import RedfishConnectionError, RedfishRequestError

router = APIRouter(prefix="/power", tags=["Power"])


class PowerActionRequest(BaseModel):
    """Request body for power actions (optional override)."""
    force: bool = Field(
        default=False,
        description="Use force variant (ForceOff instead of GracefulShutdown)",
    )


@router.get("")
async def get_power_state():
    """Get current server power state (On/Off/PoweringOn/PoweringOff)."""
    try:
        data = await redfish_service.get_power_state()
        return success_response(data=data, message="Power state retrieved")
    except RedfishConnectionError:
        raise HTTPException(status_code=503, detail=error_response(
            message="iDRAC unreachable", code="IDRAC_UNREACHABLE",
        ))
    except Exception as e:
        logger.exception(f"Power state error: {e}")
        raise HTTPException(status_code=500, detail=error_response(
            message="Failed to get power state", detail=str(e),
        ))


@router.get("/details")
async def get_power_details():
    """Get power consumption and PSU details."""
    try:
        data = await redfish_service.get_power_details()
        return success_response(data=data, message="Power details retrieved")
    except RedfishConnectionError:
        raise HTTPException(status_code=503, detail=error_response(
            message="iDRAC unreachable", code="IDRAC_UNREACHABLE",
        ))
    except Exception as e:
        logger.exception(f"Power details error: {e}")
        raise HTTPException(status_code=500, detail=error_response(
            message="Failed to get power details", detail=str(e),
        ))


@router.post("/on")
async def power_on():
    """Turn the server ON."""
    try:
        data = await redfish_service.set_power_state("On")
        return success_response(data=data, message="Power ON command sent")
    except RedfishRequestError as e:
        raise HTTPException(status_code=e.status_code, detail=error_response(
            message="Power ON failed", detail=e.detail, code="POWER_ERROR",
        ))
    except Exception as e:
        logger.exception(f"Power ON error: {e}")
        raise HTTPException(status_code=500, detail=error_response(
            message="Power ON failed", detail=str(e),
        ))


@router.post("/off")
async def power_off(body: PowerActionRequest = PowerActionRequest()):
    """
    Shut down the server.
    Default: GracefulShutdown. Use force=true for ForceOff.
    """
    reset_type = "ForceOff" if body.force else "GracefulShutdown"
    try:
        data = await redfish_service.set_power_state(reset_type)
        return success_response(data=data, message=f"{reset_type} command sent")
    except RedfishRequestError as e:
        raise HTTPException(status_code=e.status_code, detail=error_response(
            message="Power OFF failed", detail=e.detail, code="POWER_ERROR",
        ))
    except Exception as e:
        logger.exception(f"Power OFF error: {e}")
        raise HTTPException(status_code=500, detail=error_response(
            message="Power OFF failed", detail=str(e),
        ))


@router.post("/reset")
async def power_reset(body: PowerActionRequest = PowerActionRequest()):
    """
    Restart the server.
    Default: GracefulRestart. Use force=true for ForceRestart.
    """
    reset_type = "ForceRestart" if body.force else "GracefulRestart"
    try:
        data = await redfish_service.set_power_state(reset_type)
        return success_response(data=data, message=f"{reset_type} command sent")
    except RedfishRequestError as e:
        raise HTTPException(status_code=e.status_code, detail=error_response(
            message="Reset failed", detail=e.detail, code="POWER_ERROR",
        ))
    except Exception as e:
        logger.exception(f"Reset error: {e}")
        raise HTTPException(status_code=500, detail=error_response(
            message="Reset failed", detail=str(e),
        ))
