"""AI Economy — per-agent budgets, token accounting, ROI. The CFO's brain."""
from dataclasses import dataclass, field


@dataclass
class Budget:
    daily_usd: float
    spent: float = 0.0

    @property
    def remaining(self) -> float:
        return self.daily_usd - self.spent


@dataclass
class Economy:
    budgets: dict[str, Budget] = field(default_factory=dict)

    def charge(self, agent_id: str, usd: float) -> bool:
        b = self.budgets.get(agent_id)
        if b is None or b.remaining < usd:
            return False           # CFO cuts the budget automatically
        b.spent += usd
        return True
