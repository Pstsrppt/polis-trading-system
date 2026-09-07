"""Routes tasks to agents, enforces policy before every side-effect.

This is the gatekeeper: no agent acts on the world until the PolicyEngine
approves (risk limits, budget caps, required human/QA sign-off).
"""
from polis_observability import get_logger

log = get_logger("kernel.orchestrator")


class Orchestrator:
    def __init__(self, bus, agents, skills, policy):
        self.bus, self.agents, self.skills, self.policy = bus, agents, skills, policy

    async def bring_up_executive_board(self) -> None:
        for role in ("ceo", "cto", "cfo", "coo", "cmo"):
            await self.agents.spawn(role, division="executive_board")

    async def dispatch_ready_tasks(self) -> None:
        for task in await self.agents.ready_tasks():
            decision = self.policy.evaluate(task)
            if not decision.allowed:
                log.warning("Policy blocked %s · %s", task.id, decision.reason)
                await self.bus.publish("POLICY_BLOCKED", {"task": task.id, "reason": decision.reason})
                continue
            await self.agents.execute(task)
