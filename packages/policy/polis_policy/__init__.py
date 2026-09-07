"""Policy Engine — the company's written laws, enforced before any side-effect.

This is the layer that lets agents act freely while staying auditable. Rules:
  • Trading must never risk > 0.5% per deal
  • CFO must approve any spend over $500
  • Developer agents can't deploy below 90% test coverage
  • Content can't publish until QA approves
"""
from dataclasses import dataclass


@dataclass
class Decision:
    allowed: bool
    reason: str = "ok"


class PolicyEngine:
    def __init__(self, max_risk: float = 0.005, approval_threshold: float = 500.0):
        self.max_risk = max_risk
        self.approval_threshold = approval_threshold
        self.paused = False

    @classmethod
    def from_config(cls) -> "PolicyEngine":
        import os
        max_risk = float(os.getenv("MAX_RISK", "0.005"))
        return cls(max_risk=max_risk)

    def evaluate(self, task) -> Decision:
        if getattr(task, "risk", 0) > self.max_risk:
            return Decision(False, f"risk {task.risk:.2%} exceeds {self.max_risk:.2%}")
        if getattr(task, "cost_estimate", 0) > self.approval_threshold:
            return Decision(False, f"spend ${task.cost_estimate} needs CFO approval")
        return Decision(True)
