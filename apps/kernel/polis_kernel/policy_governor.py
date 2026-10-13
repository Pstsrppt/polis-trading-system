"""PolicyGovernor — board resolutions directly adjust the live risk threshold."""
import logging
import os

import redis.asyncio as aioredis

from polis_policy import PolicyEngine

log = logging.getLogger("kernel.policy_gov")

_STEP = 0.001   # ±0.1% per resolution
_MIN  = 0.002   # floor  0.2%
_MAX  = 0.010   # ceiling 1.0%


async def _publish_risk(value: float) -> None:
    r = aioredis.from_url(os.getenv("REDIS_URL", "redis://redis:6379/0"))
    try:
        await r.hset("polis:control", "max_risk", str(value))
    except Exception as exc:
        log.warning("PolicyGovernor: could not publish max_risk: %s", exc)
    finally:
        await r.aclose()


class PolicyGovernor:
    def __init__(self, bus, policy: PolicyEngine) -> None:
        self.bus    = bus
        self.policy = policy
        bus.subscribe("BOARD_RESOLUTION", self.handle)
        log.info("PolicyGovernor active — max_risk=%.2f%%", policy.max_risk * 100)

    async def handle(self, data: dict) -> None:
        resolution = data.get("resolution", "hold")
        old        = self.policy.max_risk

        if resolution == "tighten":
            self.policy.max_risk = max(_MIN, old - _STEP)
        elif resolution == "loosen":
            self.policy.max_risk = min(_MAX, old + _STEP)
        else:
            log.info("PolicyGovernor: HOLD — threshold unchanged at %.2f%%", old * 100)
            return

        new = self.policy.max_risk
        if new == old:
            log.info("PolicyGovernor: already at %s limit", "min" if resolution == "tighten" else "max")
            return

        log.info(
            "PolicyGovernor: %s → max_risk %.2f%% → %.2f%%",
            resolution.upper(), old * 100, new * 100,
        )
        await self.bus.publish("POLICY_ADJUSTED", {
            "resolution": resolution,
            "old_risk":   round(old, 4),
            "new_risk":   round(new, 4),
            "directive":  data.get("directive", ""),
        })
        # The dashboard reads risk from polis:control. Changing it only in
        # memory left that showing a value the kernel was no longer using.
        await _publish_risk(new)
