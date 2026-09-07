"""PolicyGovernor — board resolutions directly adjust the live risk threshold."""
import logging

from polis_policy import PolicyEngine

log = logging.getLogger("kernel.policy_gov")

_STEP = 0.001   # ±0.1% per resolution
_MIN  = 0.002   # floor  0.2%
_MAX  = 0.010   # ceiling 1.0%


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
