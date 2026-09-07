"""Continuously samples every agent: status, token usage, cost."""
import asyncio
import json
import os
from datetime import datetime, timezone

import redis.asyncio as aioredis

_REDIS_URL  = os.getenv("REDIS_URL", "redis://redis:6379/0")
_HEALTH_KEY = "polis:health"
_TTL_S      = 30   # key expires after 30s — gateway treats stale key as kernel down


class HealthMonitor:
    def __init__(self, agents, bus):
        self.agents, self.bus = agents, bus
        self._redis = aioredis.from_url(_REDIS_URL)

    async def run(self) -> None:
        while True:
            snapshot = await self.agents.health_snapshot()
            snapshot["ts"] = datetime.now(timezone.utc).isoformat()
            await self.bus.publish("HEALTH_TICK", snapshot)
            try:
                await self._redis.set(_HEALTH_KEY, json.dumps(snapshot), ex=_TTL_S)
            except Exception:
                pass   # Redis down — don't crash health loop
            await asyncio.sleep(5)
