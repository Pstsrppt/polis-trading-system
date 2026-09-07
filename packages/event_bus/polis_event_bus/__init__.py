"""Publish/subscribe backbone backed by Redis — events cross process boundaries.

Topics: TRADE_SIGNAL, TASK_COMPLETED, HEALTH_TICK, POLICY_BLOCKED,
        AGENT_HIRED, AGENT_FIRED, TASK_FAILED …
"""
import asyncio
import json
import os
from collections import defaultdict
from collections.abc import Awaitable, Callable

import redis.asyncio as aioredis

Handler = Callable[[dict], Awaitable[None]]


class EventBus:
    def __init__(self) -> None:
        url = os.getenv("REDIS_URL", "redis://redis:6379/0")
        self._redis = aioredis.from_url(url)
        self._subs: dict[str, list[Handler]] = defaultdict(list)

    def subscribe(self, topic: str, handler: Handler) -> None:
        self._subs[topic].append(handler)

    async def publish(self, topic: str, data: dict) -> None:
        await self._redis.publish(topic, json.dumps(data))
        # also dispatch to in-process handlers (same container)
        await asyncio.gather(*(h(data) for h in self._subs.get(topic, [])))

    async def dispatch(self, topic: str, data: dict) -> None:
        """Dispatch to local handlers only — does NOT publish to Redis.
        Used by the external-signal listener to avoid double-publishing."""
        await asyncio.gather(*(h(data) for h in self._subs.get(topic, [])))
