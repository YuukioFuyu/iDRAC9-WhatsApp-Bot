"""
Advanced Actions — Safe BMC management features.
"""

from fastapi import APIRouter, HTTPException
from loguru import logger

from app.services.redfish import redfish_service
from app.utils.response import success_response, error_response
from app.utils.retry import RedfishConnectionError, RedfishRequestError

router = APIRouter(prefix="/actions", tags=["Actions"])


@router.post("/idrac-reset")
async def reset_idrac():
    """
    Restart the iDRAC management controller safely (GracefulRestart).
    This does NOT restart the host OS or physical server.
    """
    try:
        # Base URI for iDRAC reset on Dell servers
        uri = "/redfish/v1/Managers/iDRAC.Embedded.1/Actions/Manager.Reset"
        payload = {"ResetType": "GracefulRestart"}
        
        data = await redfish_service._post(uri, payload)
        return success_response(data=data, message="iDRAC reset command sent successfully")
    except RedfishConnectionError:
        raise HTTPException(status_code=503, detail=error_response(
            message="iDRAC unreachable", code="IDRAC_UNREACHABLE",
        ))
    except RedfishRequestError as e:
        raise HTTPException(status_code=e.status_code, detail=error_response(
            message="iDRAC Reset failed", detail=e.detail, code="ACTION_ERROR",
        ))
    except Exception as e:
        logger.exception(f"iDRAC Reset error: {e}")
        raise HTTPException(status_code=500, detail=error_response(
            message="iDRAC Reset failed", detail=str(e),
        ))
