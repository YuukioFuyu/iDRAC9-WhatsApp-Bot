"""
In-memory TTL cache for Redfish API responses.
Reduces load on iDRAC by caching frequently-accessed data.
When Redis is enabled, delegates to Redis instead.
"""

import time
from typing import Any, Optional
from loguru import logger


class TTLCache:
    """Simple in-memory cache with per-key TTL expiration."""

    def __init__(self, default_ttl: int = 60):
        self._store: dict[str, dict] = {}
        self._default_ttl = default_ttl

    def get(self, key: str) -> Optional[Any]:
        """Get a cached value. Returns None if expired or missing."""
        entry = self._store.get(key)
        if entry is None:
            return None
        if time.time() > entry["expires_at"]:
            del self._store[key]
            logger.debug(f"Cache expired: {key}")
            return None
        logger.debug(f"Cache hit: {key}")
        return entry["value"]

    def set(self, key: str, value: Any, ttl: Optional[int] = None) -> None:
        """Set a cached value with optional TTL override."""
        actual_ttl = ttl if ttl is not None else self._default_ttl
        self._store[key] = {
            "value": value,
            "expires_at": time.time() + actual_ttl,
        }
        logger.debug(f"Cache set: {key} (TTL: {actual_ttl}s)")

    def delete(self, key: str) -> None:
        """Delete a specific cache entry."""
        self._store.pop(key, None)

    def clear(self) -> None:
        """Clear all cached entries."""
        self._store.clear()
        logger.info("Cache cleared")

    def has(self, key: str) -> bool:
        """Check if a key exists and is not expired."""
        return self.get(key) is not None

    @property
    def size(self) -> int:
        """Number of entries (may include expired ones)."""
        return len(self._store)


# ── Redis-backed cache (used when REDIS_ENABLED=true) ──

class RedisCache:
    """Redis-backed cache with TTL support."""

    def __init__(self, redis_client, default_ttl: int = 60, prefix: str = "idrac:"):
        self._redis = redis_client
        self._default_ttl = default_ttl
        self._prefix = f"{prefix}cache:"

    async def get(self, key: str) -> Optional[Any]:
        """Get a cached value from Redis."""
        import json
        value = await self._redis.get(f"{self._prefix}{key}")
        if value is None:
            return None
        logger.debug(f"Redis cache hit: {key}")
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return value

    async def set(self, key: str, value: Any, ttl: Optional[int] = None) -> None:
        """Set a cached value in Redis with TTL."""
        import json
        actual_ttl = ttl if ttl is not None else self._default_ttl
        serialized = json.dumps(value) if not isinstance(value, str) else value
        await self._redis.setex(
            f"{self._prefix}{key}",
            actual_ttl,
            serialized,
        )
        logger.debug(f"Redis cache set: {key} (TTL: {actual_ttl}s)")

    async def delete(self, key: str) -> None:
        """Delete a specific cache entry from Redis."""
        await self._redis.delete(f"{self._prefix}{key}")

    async def clear(self) -> None:
        """Clear all cache entries (with prefix)."""
        keys = await self._redis.keys(f"{self._prefix}*")
        if keys:
            await self._redis.delete(*keys)
        logger.info("Redis cache cleared")
