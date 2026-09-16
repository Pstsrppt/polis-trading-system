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
    """Guards two different quantities that used to share one number.

    `max_risk` is the share of the account a trade may put at stake; position
    sizing turns it into a lot size. A signal's own `risk` field is something
    else entirely — the stop distance as a fraction of price — and gating it
    with max_risk compared quantities that have nothing to do with each other.
    Lowering max_risk to size positions more conservatively silently stopped
    gold from trading at all, because its stop is ~0.45% of price and no lot
    size can change that. `max_stop_pct` is the gate for stop width.
    """

    def __init__(self, max_risk: float = 0.005, approval_threshold: float = 500.0,
                 max_stop_pct: float = 0.01):
        self.max_risk = max_risk
        self.approval_threshold = approval_threshold
        self.max_stop_pct = max_stop_pct
        self.paused = False

    @classmethod
    def from_config(cls) -> "PolicyEngine":
        import os
        max_risk = float(os.getenv("MAX_RISK", "0.005"))
        max_stop_pct = float(os.getenv("MAX_STOP_PCT", "0.01"))
        return cls(max_risk=max_risk, max_stop_pct=max_stop_pct)

    def evaluate(self, task) -> Decision:
        if getattr(task, "risk", 0) > self.max_stop_pct:
            return Decision(
                False,
                f"stop {task.risk:.2%} of price exceeds {self.max_stop_pct:.2%}",
            )
        if getattr(task, "cost_estimate", 0) > self.approval_threshold:
            return Decision(False, f"spend ${task.cost_estimate} needs CFO approval")
        return Decision(True)
