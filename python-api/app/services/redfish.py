"""
Core Redfish client for iDRAC 9 communication.

This is the primary service that all routes use to query iDRAC.
It wraps httpx.AsyncClient with:
- Automatic session management (X-Auth-Token)
- Retry logic with exponential backoff
- Response caching (TTL)
- Connection pooling (respects iDRAC session limits)
"""

import httpx
from loguru import logger
from typing import Any, Optional

from app.config import settings
from app.services.session import SessionManager
from app.services.cache import TTLCache
from app.utils.retry import (
    redfish_retry,
    RedfishSessionExpired,
    RedfishConnectionError,
    RedfishRequestError,
)


class RedfishService:
    """
    High-level Redfish client for iDRAC 9.

    Usage:
        async with RedfishService() as rf:
            system = await rf.get_system()
            power = await rf.get_power_state()
    """

    # ── iDRAC 9 Redfish URI constants ───────────────
    URI_SYSTEMS = "/redfish/v1/Systems/System.Embedded.1"
    URI_CHASSIS = "/redfish/v1/Chassis/System.Embedded.1"
    URI_MANAGERS = "/redfish/v1/Managers/iDRAC.Embedded.1"
    URI_THERMAL = "/redfish/v1/Chassis/System.Embedded.1/Thermal"
    URI_POWER = "/redfish/v1/Chassis/System.Embedded.1/Power"
    URI_STORAGE = "/redfish/v1/Systems/System.Embedded.1/Storage"
    URI_PROCESSORS = "/redfish/v1/Systems/System.Embedded.1/Processors"
    URI_MEMORY = "/redfish/v1/Systems/System.Embedded.1/Memory"
    URI_NETWORK = "/redfish/v1/Managers/iDRAC.Embedded.1/EthernetInterfaces"
    URI_RESET = "/redfish/v1/Systems/System.Embedded.1/Actions/ComputerSystem.Reset"
    URI_SEL_ENTRIES = "/redfish/v1/Managers/iDRAC.Embedded.1/LogServices/Sel/Entries"
    
    def __init__(self):
        self._client: Optional[httpx.AsyncClient] = None
        self._session_mgr: Optional[SessionManager] = None
        self._cache = TTLCache(default_ttl=60)

    async def initialize(self) -> None:
        """Initialize the HTTP client and session manager. Called during app lifespan startup."""
        self._client = httpx.AsyncClient(
            base_url=settings.idrac_host,
            verify=settings.idrac_verify_ssl,
            timeout=httpx.Timeout(settings.idrac_timeout),
            limits=httpx.Limits(
                max_connections=5,       # iDRAC has limited session slots (~6-8)
                max_keepalive_connections=3,
            ),
        )
        self._session_mgr = SessionManager(self._client)
        logger.info(f"Redfish client initialized → {settings.idrac_host}")

    async def close(self) -> None:
        """Cleanup: delete Redfish session and close HTTP client."""
        if self._session_mgr:
            await self._session_mgr.close()
        if self._client:
            await self._client.aclose()
        logger.info("Redfish client closed")

    # ── Core request method ─────────────────────────

    @redfish_retry
    async def _request(
        self,
        method: str,
        path: str,
        json_data: Optional[dict] = None,
        use_cache: bool = True,
        cache_ttl: Optional[int] = None,
    ) -> dict:
        """
        Execute an authenticated Redfish request with retry and caching.
        Automatically handles session refresh on 401.
        """
        # Check cache for GET requests
        cache_key = f"{method}:{path}"
        if method == "GET" and use_cache:
            cached = self._cache.get(cache_key)
            if cached is not None:
                return cached

        # Ensure we have a valid session
        token = await self._session_mgr.ensure_session()

        # Execute request
        try:
            resp = await self._client.request(
                method,
                path,
                headers={"X-Auth-Token": token},
                json=json_data,
            )
        except httpx.ConnectError:
            raise RedfishConnectionError(
                f"Cannot connect to iDRAC at {settings.idrac_host}"
            )

        # Handle 401 — session expired
        if resp.status_code == 401:
            self._session_mgr.invalidate()
            raise RedfishSessionExpired("Redfish session expired, will retry")

        # Handle other errors
        if resp.status_code >= 400:
            detail = ""
            try:
                error_body = resp.json()
                detail = str(
                    error_body.get("error", {}).get("message", resp.text[:200])
                )
            except Exception:
                detail = resp.text[:200]
            raise RedfishRequestError(resp.status_code, detail)

        # Parse response
        data = resp.json() if resp.content else {}

        # Cache GET responses
        if method == "GET" and use_cache:
            self._cache.set(cache_key, data, cache_ttl)

        return data

    async def get(self, path: str, cache_ttl: Optional[int] = None, use_cache: bool = True) -> dict:
        """GET request to Redfish."""
        return await self._request("GET", path, use_cache=use_cache, cache_ttl=cache_ttl)

    async def _post(self, path: str, json_data: dict) -> dict:
        """POST request proxy (useful for actions router)."""
        return await self.post(path, json_data)

    async def post(self, path: str, json_data: dict) -> dict:
        """POST request to Redfish (no caching)."""
        # Invalidate related caches on write operations
        self._cache.clear()
        return await self._request("POST", path, json_data=json_data, use_cache=False)

    # ── High-level methods ──────────────────────────

    async def get_system(self) -> dict:
        """Get full system overview (model, BIOS, hostname, health, power)."""
        data = await self.get(self.URI_SYSTEMS, cache_ttl=30)
        return {
            "model": data.get("Model", "Unknown"),
            "manufacturer": data.get("Manufacturer", "Dell Inc."),
            "serial_number": data.get("SerialNumber", ""),
            "service_tag": data.get("SKU", ""),
            "bios_version": data.get("BiosVersion", ""),
            "hostname": data.get("HostName", ""),
            "power_state": data.get("PowerState", "Unknown"),
            "health": data.get("Status", {}).get("Health", "Unknown"),
            "health_rollup": data.get("Status", {}).get("HealthRollup", "Unknown"),
            "total_memory_gb": round(
                data.get("MemorySummary", {}).get("TotalSystemMemoryGiB", 0)
            ),
            "processor_count": data.get("ProcessorSummary", {}).get("Count", 0),
            "processor_model": data.get("ProcessorSummary", {}).get("Model", ""),
        }
        
    async def get_memory(self) -> dict:
        """Get detailed memory information."""
        data = await self.get(self.URI_MEMORY, cache_ttl=300)
        modules = []
        for member in data.get("Members", []):
            mem_uri = member.get("@odata.id", "")
            if mem_uri:
                mem_data = await self.get(mem_uri, cache_ttl=300)
                if mem_data.get("Status", {}).get("State") != "Absent":
                    modules.append({
                        "id": mem_data.get("Id", "Unknown"),
                        "manufacturer": mem_data.get("Manufacturer", "Unknown"),
                        "capacity_mb": mem_data.get("CapacityMiB", 0),
                        "type": mem_data.get("MemoryDeviceType", "Unknown"),
                        "speed": mem_data.get("OperatingSpeedMhz", 0),
                        "health": mem_data.get("Status", {}).get("Health", "Unknown")
                    })
        return {
            "total_modules": len(modules),
            "modules": modules
        }

    async def get_network(self) -> dict:
        """Get detailed network interfaces information."""
        data = await self.get(self.URI_NETWORK, cache_ttl=300)
        interfaces = []
        for member in data.get("Members", []):
            nic_uri = member.get("@odata.id", "")
            if nic_uri:
                nic_data = await self.get(nic_uri, cache_ttl=300)
                if nic_data.get("Status", {}).get("State") == "Enabled":
                    ipv4_addrs = [ip.get("Address") for ip in nic_data.get("IPv4Addresses", []) if ip.get("Address")]
                    interfaces.append({
                        "id": nic_data.get("Id", "Unknown"),
                        "name": nic_data.get("Name", "NIC"),
                        "mac": nic_data.get("MACAddress", "Unknown"),
                        "speed_mbps": nic_data.get("SpeedMbps", 0),
                        "ipv4": ipv4_addrs,
                        "health": nic_data.get("Status", {}).get("Health", "Unknown")
                    })
        return {
            "total_interfaces": len(interfaces),
            "interfaces": interfaces
        }

    async def get_processors(self) -> dict:
        """Get detailed processors information."""
        data = await self.get(self.URI_PROCESSORS, cache_ttl=300)
        cpus = []
        for member in data.get("Members", []):
            cpu_uri = member.get("@odata.id", "")
            if cpu_uri:
                cpu_data = await self.get(cpu_uri, cache_ttl=300)
                if cpu_data.get("Status", {}).get("State") != "Absent":
                    cpus.append({
                        "id": cpu_data.get("Id", "Unknown"),
                        "model": cpu_data.get("Model", "Unknown"),
                        "cores": cpu_data.get("TotalCores", 0),
                        "threads": cpu_data.get("TotalThreads", 0),
                        "speed_mhz": cpu_data.get("MaxSpeedMHz", 0),
                        "health": cpu_data.get("Status", {}).get("Health", "Unknown")
                    })
        return {
            "total_cpus": len(cpus),
            "cpus": cpus
        }

    async def get_power_state(self) -> dict:
        """Get current power state."""
        data = await self.get(self.URI_SYSTEMS, cache_ttl=10)
        return {
            "power_state": data.get("PowerState", "Unknown"),
            "health": data.get("Status", {}).get("Health", "Unknown"),
        }

    async def set_power_state(self, reset_type: str) -> dict:
        """
        Execute a power action.
        Valid reset types: On, ForceOff, GracefulShutdown, ForceRestart, PushPowerButton
        """
        valid_types = [
            "On", "ForceOff", "GracefulShutdown", "GracefulRestart",
            "ForceRestart", "PushPowerButton", "Nmi",
        ]
        if reset_type not in valid_types:
            raise ValueError(f"Invalid reset type: {reset_type}. Valid: {valid_types}")

        logger.warning(f"Executing power action: {reset_type}")
        result = await self.post(self.URI_RESET, {"ResetType": reset_type})
        return {
            "action": reset_type,
            "result": "accepted",
            "detail": result,
        }

    async def get_thermal(self) -> dict:
        """Get thermal data: temperatures and fan speeds."""
        data = await self.get(self.URI_THERMAL, cache_ttl=15)

        temperatures = []
        for temp in data.get("Temperatures", []):
            if temp.get("Status", {}).get("State") == "Enabled":
                temperatures.append({
                    "name": temp.get("Name", "Unknown"),
                    "reading_celsius": temp.get("ReadingCelsius"),
                    "upper_threshold_critical": temp.get("UpperThresholdCritical"),
                    "upper_threshold_fatal": temp.get("UpperThresholdFatal"),
                    "health": temp.get("Status", {}).get("Health", "Unknown"),
                })

        fans = []
        for fan in data.get("Fans", []):
            if fan.get("Status", {}).get("State") == "Enabled":
                fans.append({
                    "name": fan.get("Name", fan.get("FanName", "Unknown")),
                    "reading_rpm": fan.get("Reading"),
                    "units": fan.get("ReadingUnits", "RPM"),
                    "health": fan.get("Status", {}).get("Health", "Unknown"),
                })

        return {
            "temperatures": temperatures,
            "fans": fans,
        }

    async def get_power_details(self) -> dict:
        """Get power consumption and PSU details."""
        data = await self.get(self.URI_POWER, cache_ttl=15)

        power_control = []
        for ctrl in data.get("PowerControl", []):
            power_control.append({
                "name": ctrl.get("Name", "System Power Control"),
                "consumed_watts": ctrl.get("PowerConsumedWatts"),
                "capacity_watts": ctrl.get("PowerCapacityWatts"),
                "min_watts": ctrl.get("PowerMetrics", {}).get("MinConsumedWatts"),
                "max_watts": ctrl.get("PowerMetrics", {}).get("MaxConsumedWatts"),
                "avg_watts": ctrl.get("PowerMetrics", {}).get("AverageConsumedWatts"),
            })

        power_supplies = []
        for psu in data.get("PowerSupplies", []):
            if psu.get("Status", {}).get("State") == "Enabled":
                power_supplies.append({
                    "name": psu.get("Name", "Unknown"),
                    "model": psu.get("Model", ""),
                    "capacity_watts": psu.get("PowerCapacityWatts"),
                    "output_watts": psu.get("LastPowerOutputWatts"),
                    "input_voltage": psu.get("LineInputVoltage"),
                    "health": psu.get("Status", {}).get("Health", "Unknown"),
                })

        return {
            "power_control": power_control,
            "power_supplies": power_supplies,
        }

    async def get_storage(self) -> dict:
        """Get storage controllers and drives."""
        data = await self.get(self.URI_STORAGE, cache_ttl=120)

        controllers = []
        for member in data.get("Members", []):
            ctrl_uri = member.get("@odata.id", "")
            if ctrl_uri:
                ctrl_data = await self.get(ctrl_uri, cache_ttl=120)
                drives = []
                for drive_ref in ctrl_data.get("Drives", []):
                    drive_uri = drive_ref.get("@odata.id", "")
                    if drive_uri:
                        drive_data = await self.get(drive_uri, cache_ttl=120)
                        drives.append({
                            "name": drive_data.get("Name", "Unknown"),
                            "model": drive_data.get("Model", ""),
                            "capacity_bytes": drive_data.get("CapacityBytes", 0),
                            "capacity_gb": round(
                                drive_data.get("CapacityBytes", 0) / (1024**3), 1
                            ),
                            "media_type": drive_data.get("MediaType", ""),
                            "protocol": drive_data.get("Protocol", ""),
                            "serial": drive_data.get("SerialNumber", ""),
                            "health": drive_data.get(
                                "Status", {}
                            ).get("Health", "Unknown"),
                            "state": drive_data.get(
                                "Status", {}
                            ).get("State", "Unknown"),
                        })
                controllers.append({
                    "name": ctrl_data.get("Name", "Unknown"),
                    "id": ctrl_data.get("Id", ""),
                    "health": ctrl_data.get(
                        "Status", {}
                    ).get("Health", "Unknown"),
                    "drives_count": len(drives),
                    "drives": drives,
                })

        return {"controllers": controllers}

    async def get_sel_entries(self, limit: int = 50) -> dict:
        """Get System Event Log entries (most recent first)."""
        # Redfish supports $top query parameter for pagination
        uri = f"{self.URI_SEL_ENTRIES}?$top={limit}&$orderby=Created desc"
        data = await self.get(uri, cache_ttl=30)

        entries = []
        for entry in data.get("Members", []):
            entries.append({
                "id": entry.get("Id", ""),
                "created": entry.get("Created", ""),
                "message": entry.get("Message", ""),
                "severity": entry.get("Severity", entry.get("EntryType", "")),
                "message_id": entry.get("MessageId", ""),
                "sensor_type": entry.get("SensorType", ""),
            })

        return {
            "count": data.get("Members@odata.count", len(entries)),
            "entries": entries,
        }

    async def get_sel_latest(self, count: int = 5) -> dict:
        """Get the latest N SEL entries (for alert diffing)."""
        return await self.get_sel_entries(limit=count)

    async def check_reachability(self) -> dict:
        """Quick connectivity check to iDRAC."""
        try:
            resp = await self._client.get(
                "/redfish/v1/",
                timeout=5.0,
            )
            return {
                "reachable": True,
                "status_code": resp.status_code,
                "product": resp.json().get("Product", "iDRAC"),
                "redfish_version": resp.json().get("RedfishVersion", ""),
            }
        except Exception as e:
            return {
                "reachable": False,
                "error": str(e),
            }


# ── Singleton instance (initialized in app lifespan) ──
redfish_service = RedfishService()
