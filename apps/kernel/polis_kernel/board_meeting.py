"""Executive Board Meeting — 5 AI officers review metrics and issue a strategic resolution."""
import asyncio
import json
import logging
import os
from datetime import datetime, timezone

import redis.asyncio as aioredis

from polis_llm import LLMClient
from . import db
from .cost_tracker import cost_tracker

log = logging.getLogger("kernel.board")

# Each executive's LLM persona
EXECUTIVES: dict[str, str] = {
    "cfo": "Chief Financial Officer: analyse risk exposure, approval rate, financial efficiency. Be concise.",
    "cto": "Chief Technology Officer: analyse AI pipeline reliability, LLM quality, system health. Be concise.",
    "coo": "Chief Operating Officer: analyse operational throughput, signal-to-decision latency, pipeline efficiency. Be concise.",
    "cmo": "Chief Marketing Officer: analyse market sentiment trends, regime distribution, directional bias. Be concise.",
}

_EXEC_SYSTEM = """You are the {title} of POLIS AI Trading Operating System.
Review the trading metrics below and give your board assessment.
Respond with JSON ONLY — no markdown:
{{"assessment": "one sentence from your functional perspective", "vote": "tighten"|"hold"|"loosen"}}

tighten = tighten risk limits (fewer trades, safer)
hold    = maintain current parameters
loosen  = loosen risk limits (more trades, more aggressive)"""

_CEO_SYSTEM = """You are the CEO of POLIS AI Trading Operating System.
Your four executives have reviewed performance metrics and cast their votes.
Synthesise their input and issue the official board resolution.
Respond with JSON ONLY — no markdown:
{{"resolution": "tighten"|"hold"|"loosen", "directive": "one authoritative directive sentence", "confidence": 0-100}}"""


class BoardMeeting:
    def __init__(self, bus, interval: int = 300) -> None:
        self.bus        = bus
        self.interval   = interval
        self._llm       = LLMClient()
        self._trigger   = asyncio.Event()
        self._redis_url = os.getenv("REDIS_URL", "redis://redis:6379/0")
        bus.subscribe("BOARD_TRIGGER",   self._on_trigger)
        bus.subscribe("SETTINGS_UPDATE", self._on_settings_update)
        log.info("BoardMeeting scheduled every %ds", interval)

    async def _on_trigger(self, data: dict) -> None:
        log.info("Board meeting manually triggered from dashboard")
        self._trigger.set()

    async def _on_settings_update(self, data: dict) -> None:
        if "board_interval_s" in data:
            new_val = int(max(60, min(3600, data["board_interval_s"])))
            if new_val != self.interval:
                log.info("BoardMeeting interval: %ds → %ds", self.interval, new_val)
                self.interval = new_val
                self._trigger.set()   # wake current wait — next cycle uses new interval

    async def run(self) -> None:
        await asyncio.sleep(45)          # let kernel settle before first meeting
        while True:
            try:
                await self._hold_meeting()
            except Exception as exc:
                log.error("Board meeting error: %s", exc)
            self._trigger.clear()
            try:
                await asyncio.wait_for(self._trigger.wait(), timeout=self.interval)
                log.info("Board meeting triggered early — running now")
            except asyncio.TimeoutError:
                pass

    async def _world_snapshot(self) -> dict:
        """Fetch latest world model from Redis for board context."""
        try:
            r = aioredis.from_url(self._redis_url, socket_timeout=2.0)
            raw = await r.get("polis:world")
            await r.aclose()
            return json.loads(raw) if raw else {}
        except Exception:
            return {}

    async def _hold_meeting(self) -> None:
        metrics = await db.recent_metrics(minutes=self.interval // 60 + 1)
        if metrics["total"] == 0:
            log.info("Board meeting skipped — no trades in window")
            return

        # Enrich metrics with live macro context
        world = await self._world_snapshot()
        if world:
            metrics["market_regime"]  = world.get("regime", "UNKNOWN")
            metrics["fear_greed"]     = f"{world.get('fg_value','?')}/100 ({world.get('fg_classification','?')})"
            metrics["gold_price"]     = world.get("gold_price")
            metrics["eur_price"]      = world.get("eur_price")
            metrics["btc_price"]      = world.get("btc_price")
            metrics["dxy_chg_pct"]    = world.get("dxy_chg_pct")
            metrics["price_source"]   = world.get("_price_source", "?")

        log.info(
            "Board meeting called — %d decisions (%.0f%% approved) regime=%s",
            metrics["total"], metrics["approval_rate"],
            metrics.get("market_regime", "?"),
        )
        await self.bus.publish("BOARD_MEETING", {
            "status": "started",
            "metrics": metrics,
            "ts": datetime.now(timezone.utc).isoformat(),
        })

        # All 4 officers assess in parallel
        results = await asyncio.gather(
            *[self._officer_assess(role, desc, metrics) for role, desc in EXECUTIVES.items()],
            return_exceptions=True,
        )
        exec_views: dict[str, dict] = {}
        for (role, _), result in zip(EXECUTIVES.items(), results):
            if isinstance(result, Exception):
                log.warning("Officer %s unavailable: %s", role, result)
                exec_views[role] = {"assessment": "data unavailable", "vote": "hold"}
            else:
                exec_views[role] = result
                log.info("  %s → %s (vote: %s)", role.upper(), result.get("assessment", "")[:60], result.get("vote"))

        # CEO synthesises
        votes        = [v["vote"] for v in exec_views.values()]
        board_summary = "\n".join(
            f"{role.upper()}: {v['assessment']} [vote: {v['vote']}]"
            for role, v in exec_views.items()
        )
        try:
            ceo = await asyncio.wait_for(
                self._llm.complete_json(
                    system=_CEO_SYSTEM,
                    user=(
                        f"Performance metrics: {metrics}\n\n"
                        f"Board assessments:\n{board_summary}\n\n"
                        f"Vote tally — tighten:{votes.count('tighten')} "
                        f"hold:{votes.count('hold')} loosen:{votes.count('loosen')}"
                    ),
                ),
                timeout=20.0,
            )
        except Exception as exc:
            log.error("CEO LLM error: %s — defaulting to HOLD", exc)
            ceo = {"resolution": "hold", "directive": "Insufficient board data — maintaining current parameters.", "confidence": 40}
        else:
            cost_tracker.record("gemini", agent="ceo")

        resolution = {
            "resolution": ceo.get("resolution", "hold"),
            "directive":  ceo.get("directive", ""),
            "confidence": ceo.get("confidence", 50),
            "metrics":    metrics,
            "exec_views": exec_views,
            "ts":         datetime.now(timezone.utc).isoformat(),
        }
        log.info(
            "BOARD_RESOLUTION → %s (conf=%s): %s",
            resolution["resolution"].upper(), resolution["confidence"], resolution["directive"],
        )
        await asyncio.gather(
            self.bus.publish("BOARD_RESOLUTION", resolution),
            db.save_resolution(resolution),
        )

    async def _officer_assess(self, role: str, description: str, metrics: dict) -> dict:
        result = await asyncio.wait_for(
            self._llm.complete_json(
                system=_EXEC_SYSTEM.format(title=description),
                user=f"Trading metrics: {metrics}",
            ),
            timeout=15.0,
        )
        cost_tracker.record("gemini", agent=role)
        return result
