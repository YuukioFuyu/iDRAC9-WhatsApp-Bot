"""
FastAPI main application — iDRAC 9 Redfish Bridge API.

This service provides a clean REST API over the iDRAC Redfish interface.
It handles session management, caching, and retry logic internally.
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger
import sys

from app.config import settings
from app.services.redfish import redfish_service
from app.routes import health, system, power, thermal, storage, logs, actions


# ── Configure Loguru ────────────────────────────────
logger.remove()  # Remove default stderr handler
logger.add(
    sys.stderr,
    level=settings.log_level.upper(),
    format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | "
           "<level>{level: <8}</level> | "
           "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> — "
           "<level>{message}</level>",
    colorize=True,
)


# ── App Lifespan (startup + shutdown) ───────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Manage application lifecycle:
    - Startup: Initialize Redfish client + session
    - Shutdown: Cleanup session + close HTTP client
    """
    logger.info("=" * 60)
    logger.info("🚀 iDRAC Redfish API starting...")
    logger.info(f"   Target: {settings.idrac_host}")
    logger.info(f"   SSL Verify: {settings.idrac_verify_ssl}")
    logger.info(f"   Timeout: {settings.idrac_timeout}s")
    logger.info(f"   Session TTL: {settings.idrac_session_ttl}s")
    logger.info("=" * 60)

    # Initialize Redfish service
    await redfish_service.initialize()

    # Test connectivity (non-blocking, don't fail startup)
    try:
        status = await redfish_service.check_reachability()
        if status["reachable"]:
            logger.info(
                f"✅ iDRAC reachable — "
                f"Product: {status.get('product', 'N/A')}, "
                f"Redfish: {status.get('redfish_version', 'N/A')}"
            )
        else:
            logger.warning(
                f"⚠️  iDRAC not reachable at startup: {status.get('error', 'Unknown')}"
            )
    except Exception as e:
        logger.warning(f"⚠️  Could not check iDRAC connectivity: {e}")

    yield  # ← App is running

    # Shutdown
    logger.info("Shutting down Redfish client...")
    await redfish_service.close()
    logger.info("👋 iDRAC Redfish API stopped")


# ── Create FastAPI app ──────────────────────────────
app = FastAPI(
    title="iDRAC9 Redfish Bridge API",
    description=(
        "REST API bridge for Dell iDRAC 9 Redfish interface. "
        "Provides simplified endpoints for system status, power management, "
        "thermal monitoring, storage info, and event logs."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

# ── CORS (internal only, but allow for development) ─
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restricted in production via reverse proxy
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Register Routes ─────────────────────────────────
app.include_router(health.router)
app.include_router(system.router)
app.include_router(power.router)
app.include_router(thermal.router)
app.include_router(storage.router)
app.include_router(logs.router)
app.include_router(actions.router)


# ── Root redirect to docs ───────────────────────────
@app.get("/", include_in_schema=False)
async def root():
    """Redirect root to API documentation."""
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/docs")
