"""
Health check route — service status + iDRAC reachability.
"""

from fastapi import APIRouter
from app.services.redfish import redfish_service
from app.utils.response import success_response, error_response

router = APIRouter(tags=["Health"])


@router.get("/health")
async def health_check():
    """
    Service health check.
    Returns service status and iDRAC connectivity info.
    Used by Docker healthcheck and Node.js service dependency.
    """
    idrac_status = await redfish_service.check_reachability()

    return success_response(
        data={
            "service": "python-redfish-api",
            "status": "healthy",
            "idrac": idrac_status,
        },
        message="Service is running",
    )
