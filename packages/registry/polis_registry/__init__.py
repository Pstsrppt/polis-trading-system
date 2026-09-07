"""Agent / Skill / Model registries — the single source of truth for who exists."""
from polis_core import Agent
from polis_llm import LLMClient


class AgentRegistry:
    def __init__(self, bus):
        self.bus = bus
        self._agents: dict[str, Agent] = {}

    async def spawn(self, role: str, division: str, **kw) -> Agent:
        agent = Agent(role=role, division=division, **kw)
        self._agents[agent.id] = agent
        await self.bus.publish("AGENT_HIRED", {"id": agent.id, "role": role})
        return agent

    async def fire(self, agent_id: str, reason: str) -> None:
        self._agents.pop(agent_id, None)
        await self.bus.publish("AGENT_FIRED", {"id": agent_id, "reason": reason})

    async def health_snapshot(self) -> dict:
        return {"agents": len(self._agents)}

    async def ready_tasks(self) -> list:
        return []  # TODO: pull from task queue

    async def execute(self, task) -> None:
        agent = next(
            (a for a in self._agents.values() if a.division == task.division),
            None,
        )
        if not agent:
            await self.bus.publish("TASK_FAILED", {"task_id": task.id, "reason": "no agent available"})
            return

        llm = LLMClient(model=agent.model)
        result = await llm.complete(
            system=f"You are the {agent.role} of POLIS, an AI enterprise. Execute assigned tasks decisively and concisely.",
            user=f"Task: {task.intent}\nPayload: {task.payload}",
        )
        await self.bus.publish("TASK_COMPLETED", {"task_id": task.id, "agent": agent.role, "result": result})


class SkillRegistry:
    @classmethod
    def load(cls) -> "SkillRegistry":
        return cls()  # TODO: load skill manifests from marketplace/
