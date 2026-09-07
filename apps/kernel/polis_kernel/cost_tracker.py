"""LLM Cost Tracker — accumulates per-provider call stats in Redis.

Usage (from any kernel module after import):
    from .cost_tracker import cost_tracker
    cost_tracker.record("gemini", agent="cto", input_tokens=600, output_tokens=150)

Stats stored in Redis key polis:llm_costs (JSON string).
Flushed to Redis every 15 seconds via flush() coroutine.
"""
import asyncio
import json
import logging
import os
from datetime import datetime, timezone

import redis.asyncio as aioredis

log = logging.getLogger("kernel.cost")

_REDIS_KEY = "polis:llm_costs"

# Approximate cost per 1 000 tokens (USD)
_RATES: dict[str, dict[str, float]] = {
    "gemini":      {"input": 0.000075, "output": 0.000300},  # Gemini 2.0 Flash Lite
    "groq":        {"input": 0.0,      "output": 0.0},       # free tier
    "openrouter":  {"input": 0.0,      "output": 0.0},       # free tier
}

# Rough token estimates per call when exact counts aren't available
_DEFAULT_TOKENS = {"input": 500, "output": 200}


class CostTracker:
    def __init__(self) -> None:
        self._redis_url = os.getenv("REDIS_URL", "redis://redis:6379/0")
        self._buffer:   list[dict] = []

    def record(
        self,
        provider:      str,
        agent:         str  = "unknown",
        input_tokens:  int  = _DEFAULT_TOKENS["input"],
        output_tokens: int  = _DEFAULT_TOKENS["output"],
    ) -> None:
        """Buffer a cost record (non-blocking, flushed every 15 s)."""
        self._buffer.append({
            "provider":      provider,
            "agent":         agent,
            "input_tokens":  input_tokens,
            "output_tokens": output_tokens,
            "ts":            datetime.now(timezone.utc).isoformat(),
        })

    async def flush(self) -> None:
        """Coroutine that periodically writes buffered records to Redis."""
        while True:
            await asyncio.sleep(15)
            if not self._buffer:
                continue
            records, self._buffer = self._buffer[:], []
            try:
                r = aioredis.from_url(self._redis_url)

                # Load existing aggregate
                raw      = await r.get(_REDIS_KEY)
                existing: dict = json.loads(raw) if raw else {}

                for rec in records:
                    prov  = rec["provider"]
                    rates = _RATES.get(prov, {"input": 0.0, "output": 0.0})
                    cost  = (
                        rec["input_tokens"]  / 1000 * rates["input"] +
                        rec["output_tokens"] / 1000 * rates["output"]
                    )

                    # ── per-provider totals ──────────────────────────
                    pb = existing.setdefault(prov, {
                        "calls": 0, "input_tokens": 0,
                        "output_tokens": 0, "cost_usd": 0.0,
                    })
                    pb["calls"]         += 1
                    pb["input_tokens"]  += rec["input_tokens"]
                    pb["output_tokens"] += rec["output_tokens"]
                    pb["cost_usd"]       = round(pb["cost_usd"] + cost, 8)

                    # ── per-agent totals ─────────────────────────────
                    agents_key = "agents"
                    agents = existing.setdefault(agents_key, {})
                    ab = agents.setdefault(rec["agent"], {
                        "calls": 0, "cost_usd": 0.0,
                    })
                    ab["calls"]    += 1
                    ab["cost_usd"]  = round(ab["cost_usd"] + cost, 8)

                    # ── session totals ───────────────────────────────
                    tot = existing.setdefault("total", {
                        "calls": 0, "cost_usd": 0.0,
                    })
                    tot["calls"]    += 1
                    tot["cost_usd"]  = round(tot["cost_usd"] + cost, 8)

                existing["last_updated"] = datetime.now(timezone.utc).isoformat()
                await r.set(_REDIS_KEY, json.dumps(existing))
                await r.aclose()
            except Exception as exc:
                log.warning("Cost tracker flush error: %s", exc)
                self._buffer.extend(records)   # re-queue on failure


# Module-level singleton — import this in board_meeting, research_agent, etc.
cost_tracker = CostTracker()
