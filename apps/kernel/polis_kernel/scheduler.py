"""Time + priority scheduler. Decides *when* work runs."""
import asyncio
from dataclasses import dataclass


@dataclass
class Scheduler:
    orchestrator: object
    tick_seconds: float = 1.0

    async def run(self) -> None:
        while True:
            await self.orchestrator.dispatch_ready_tasks()
            await asyncio.sleep(self.tick_seconds)
