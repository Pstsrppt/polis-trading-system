"""Risk Agent — vets every trade signal before it touches the market.

Tight stops fail on XAUUSD because spread can exceed stop distance;
this agent sizes stops in ATR/spread terms, not fixed pips, and uses
the LLM only for qualitative bias — hard math always wins.
"""
from polis_core import Task
from polis_llm import LLMClient

_SYSTEM = """You are the POLIS Risk Agent for XAUUSD trading.
Given a trade signal, respond with JSON:
{"approved": true/false, "confidence": 0-100, "reason": "one line"}
Rules: reject if risk > 0.5%, stop < 3x spread, or bias is unclear."""


class RiskAgent:
    def __init__(self, max_risk: float = 0.005, min_stop_atr: float = 1.2):
        self.max_risk = max_risk
        self.min_stop_atr = min_stop_atr
        self._llm = LLMClient()

    def vet(self, task: Task, atr: float, spread: float) -> bool:
        """Fast deterministic check — no LLM needed."""
        min_stop = max(self.min_stop_atr * atr, spread * 3)
        return task.risk <= self.max_risk and task.payload.get("stop", 0) >= min_stop

    async def vet_with_reasoning(self, task: Task, atr: float, spread: float) -> dict:
        """Deterministic guard first, then LLM qualitative review."""
        hard_pass = self.vet(task, atr, spread)
        if not hard_pass:
            return {"approved": False, "confidence": 100, "reason": "failed hard risk rules"}

        result = await self._llm.complete_json(
            system=_SYSTEM,
            user=(
                f"Signal: {task.intent}\n"
                f"Risk: {task.risk:.3%}  ATR: {atr}  Spread: {spread}\n"
                f"Payload: {task.payload}"
            ),
        )
        return result
