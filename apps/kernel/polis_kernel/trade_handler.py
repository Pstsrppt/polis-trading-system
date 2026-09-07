"""Handles SIGNAL_APPROVED: hard policy check → LLM review (with memory) → decision."""
import asyncio
import logging
import os
from typing import TYPE_CHECKING
from uuid import uuid4

from polis_core import Task
from polis_llm import LLMClient
from polis_policy import PolicyEngine

from . import db
from .oanda_broker import OandaBroker

if TYPE_CHECKING:
    from .memory_store import MemoryStore

log = logging.getLogger("kernel.trade")

_ACCOUNT_BALANCE = float(os.getenv("ACCOUNT_BALANCE_USD", "10000"))
_MAX_RISK_PCT    = float(os.getenv("MAX_RISK", "0.005")) * 100

# ATR baselines per symbol (typical M5 ATR in price units)
_ATR_BASELINES: dict[str, float] = {
    "XAUUSD": 12.0, "EURUSD": 0.0012, "GBPUSD": 0.0014,
    "BTCUSD": 400.0, "XAGUSD": 0.20,
}
_REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")

# Per-instrument contract specification
_CONTRACT: dict[str, dict] = {
    "XAUUSD": {"instrument": "XAU_USD", "units_per_lot": 100,     "risk_per_lot": lambda s: s * 100},
    "EURUSD": {"instrument": "EUR_USD", "units_per_lot": 100_000, "risk_per_lot": lambda s: s * 100_000},
    "GBPUSD": {"instrument": "GBP_USD", "units_per_lot": 100_000, "risk_per_lot": lambda s: s * 100_000},
    "BTCUSD": {"instrument": "BTC_USD", "units_per_lot": 1,       "risk_per_lot": lambda s: s * 1},
    "XAGUSD": {"instrument": "XAG_USD", "units_per_lot": 5_000,   "risk_per_lot": lambda s: s * 5_000},
}
_DEFAULT_CONTRACT = _CONTRACT["XAUUSD"]


def _atr_scale(symbol: str, atr: float) -> float:
    """Dynamic lot scaling based on current vs. baseline ATR."""
    baseline = _ATR_BASELINES.get(symbol.upper(), 12.0)
    if baseline <= 0 or atr <= 0:
        return 1.0
    ratio = atr / baseline
    if ratio > 2.0:  return 0.5    # 2×+ volatile  → 50% lot
    if ratio > 1.5:  return 0.7    # 1.5× volatile → 70% lot
    if ratio < 0.5:  return 1.3    # very quiet    → 130% lot
    if ratio < 0.7:  return 1.15   # quiet         → 115% lot
    return 1.0                     # normal range


async def _get_recovery_scale() -> float:
    """Read recovery lot scale from Redis (set by circuit_breaker on drawdown)."""
    try:
        import redis.asyncio as aioredis  # noqa: PLC0415
        r   = aioredis.from_url(_REDIS_URL, socket_timeout=1.0)
        raw = await r.get("polis:recovery_scale")
        await r.aclose()
        return float(raw) if raw else 1.0
    except Exception:
        return 1.0


def _calc_lots(symbol: str, stop: float, max_risk: float,
               atr: float = 0, extra_scale: float = 1.0) -> float:
    """Risk-based position sizing with ATR-dynamic scaling.

    lots = (account × max_risk × atr_scale × extra_scale) / risk_per_lot(stop)
    Clipped to [0.01, 100.00].
    """
    if stop <= 0:
        return 0.01
    contract     = _CONTRACT.get(symbol.upper(), _DEFAULT_CONTRACT)
    atr_s        = _atr_scale(symbol, atr) if atr > 0 else 1.0
    risk_usd     = _ACCOUNT_BALANCE * max_risk * atr_s * extra_scale
    risk_per_lot = contract["risk_per_lot"](stop)
    if risk_per_lot <= 0:
        return 0.01
    return max(0.01, min(100.0, round(risk_usd / risk_per_lot, 2)))

_SYSTEM = f"""You are the POLIS Risk Agent for multi-symbol trading (XAU, EUR, GBP, BTC).
You receive a trade signal AND a Research Division market-context report.
Respond with JSON ONLY — no markdown, no explanation outside JSON:
{{"approved": true/false, "confidence": 0-100, "reason": "one concise line"}}

Hard rules:
- Reject if risk > {_MAX_RISK_PCT:.1f}% of account
- Reject if stop < 3x spread (stop too tight, will be hunted by spread)
- Reject if stop < 1.2x ATR (too tight for volatility)
Soft rules:
- Weight Research sentiment: bullish favours long, bearish favours short
- volatile regime → tighter confidence threshold (need 70+)
- Confidence < 60 = reject"""


class TradeHandler:
    def __init__(self, bus, policy: PolicyEngine, memory: "MemoryStore | None" = None) -> None:
        self.bus    = bus
        self.policy = policy
        self._llm   = LLMClient()
        self._mem   = memory
        self._broker = OandaBroker()
        bus.subscribe("SIGNAL_APPROVED", self.handle)
        log.info("TradeHandler ready — subscribed to SIGNAL_APPROVED")

    async def handle(self, data: dict) -> None:
        symbol    = data.get("symbol", "XAUUSD")
        direction = data.get("direction", "long")
        price     = data.get("price")
        risk      = data.get("risk", 0)
        stop      = data.get("stop", 0)
        atr       = data.get("atr", 10)
        spread    = data.get("spread", 0.5)

        # ── 1. Hard policy gate (no LLM cost) ──────────────────────────
        task = Task(
            id=str(uuid4()),
            intent=f"TRADE {direction.upper()} {symbol}",
            payload=data,
            division="trading",
            risk=risk,
        )
        decision = self.policy.evaluate(task)
        if not decision.allowed:
            log.info("POLICY_BLOCKED %s %s — %s", direction, symbol, decision.reason)
            research = data.get("research", {})
            await asyncio.gather(
                self.bus.publish("POLICY_BLOCKED", {
                    "task_id": task.id, "symbol": symbol,
                    "direction": direction, "reason": decision.reason,
                    "price": price, "risk": risk,
                }),
                db.save_decision(
                    task_id=task.id, symbol=symbol, direction=direction,
                    outcome="BLOCKED", price=price, risk=risk, stop=stop,
                    reason=decision.reason,
                ),
            )
            if self._mem:
                await self._mem.store(
                    direction=direction, risk=risk, atr=atr, spread=spread,
                    sentiment=research.get("sentiment", "neutral"),
                    regime=research.get("regime", "ranging"),
                    outcome="BLOCKED", confidence=None, reason=decision.reason,
                    symbol=symbol, price=price,
                )
            return

        # ── 2. LLM qualitative review (with research + memory context) ─
        research = data.get("research", {})
        memory   = data.get("memory", [])

        research_line = (
            f"Research: sentiment={research.get('sentiment','?')} "
            f"regime={research.get('regime','?')} "
            f"conf={research.get('confidence','?')} "
            f"factors={research.get('factors',[])}"
        ) if research else "Research: not available"

        memory_lines = ""
        if memory:
            bullets = "\n".join(
                f"  • {m['direction']} {m['sentiment']}/{m['regime']} "
                f"risk={m.get('risk',0):.3f} → {m['outcome']} "
                f"({m.get('confidence','?')}%) \"{m.get('reason','')}\"  [sim={m['score']}]"
                for m in memory
            )
            memory_lines = f"\nMemory ({len(memory)} similar past decisions):\n{bullets}"

        try:
            result = await asyncio.wait_for(
                self._llm.complete_json(
                    system=_SYSTEM,
                    user=(
                        f"Signal: {direction.upper()} {symbol} @ {price}\n"
                        f"Risk: {risk:.3%}   ATR: {atr}   Spread: {spread}   Stop: {stop}\n"
                        f"{research_line}"
                        f"{memory_lines}"
                    ),
                ),
                timeout=20.0,
            )
        except Exception as exc:
            log.error("LLM timeout/error: %s — using hard-pass fallback", exc)
            result = {"approved": True, "confidence": 65, "reason": "LLM unavailable — hard rules passed"}

        confidence = result.get("confidence", 0)
        reason     = result.get("reason", "")

        if result.get("approved") and confidence >= 60:
            contract     = _CONTRACT.get(symbol.upper(), _DEFAULT_CONTRACT)
            corr_scale   = float(data.get("lot_scale", 1.0))     # from signal_filter
            recov_scale  = await _get_recovery_scale()            # from circuit_breaker
            extra_scale  = round(corr_scale * recov_scale, 3)
            lots         = _calc_lots(symbol=symbol, stop=stop, max_risk=self.policy.max_risk,
                                      atr=atr, extra_scale=extra_scale)
            notional  = round(lots * contract["units_per_lot"] * (price or 0), 2)
            risk_usd  = round(contract["risk_per_lot"](stop) * lots, 2)
            atr_s = _atr_scale(symbol, atr)
            log.info(
                "TRADE_APPROVED %s %s conf=%s  lots=%.2f  risk_usd=$%.2f  notional=$%.0f"
                "  [atr×%.2f corr×%.2f recov×%.2f]",
                direction, symbol, confidence, lots, risk_usd, notional,
                atr_s, corr_scale, recov_scale,
            )

            # ── Execute via broker ──────────────────────────────────────
            broker_result = await self._broker.place_order(
                direction=direction,
                lots=lots,
                price=price or 0,
                stop=stop,
                instrument=contract["instrument"],
                units_per_lot=contract["units_per_lot"],
            )
            broker_order_id = broker_result.get("order_id")
            fill_price      = broker_result.get("fill_price", price)

            db_id = await db.save_decision(
                task_id=task.id, symbol=symbol, direction=direction,
                outcome="APPROVED", price=price, risk=risk, stop=stop,
                confidence=confidence, reason=reason, lots=lots,
                risk_usd=risk_usd,
                broker_order_id=broker_order_id, fill_price=fill_price,
            )
            await self.bus.publish("TRADE_APPROVED", {
                "task_id": task.id, "symbol": symbol,
                "direction": direction, "price": price,
                "risk": risk, "stop": stop,
                "confidence": confidence, "reason": reason,
                "lots": lots, "notional_usd": notional, "risk_usd": risk_usd,
                "account_balance": _ACCOUNT_BALANCE,
                "broker_order_id": broker_order_id,
                "fill_price": fill_price,
                "broker_live": self._broker.enabled,
                "db_id": db_id,
            })
            if self._mem:
                await self._mem.store(
                    direction=direction, risk=risk, atr=atr, spread=spread,
                    sentiment=research.get("sentiment", "neutral"),
                    regime=research.get("regime", "ranging"),
                    outcome="APPROVED", confidence=confidence, reason=reason,
                    symbol=symbol, price=price,
                )
        else:
            log.info("LLM_BLOCKED %s %s — %s", direction, symbol, reason)
            await asyncio.gather(
                self.bus.publish("POLICY_BLOCKED", {
                    "task_id": task.id, "symbol": symbol,
                    "direction": direction, "reason": reason,
                    "llm_confidence": confidence,
                }),
                db.save_decision(
                    task_id=task.id, symbol=symbol, direction=direction,
                    outcome="BLOCKED", price=price, risk=risk, stop=stop,
                    confidence=confidence, reason=reason,
                ),
            )
            if self._mem:
                await self._mem.store(
                    direction=direction, risk=risk, atr=atr, spread=spread,
                    sentiment=research.get("sentiment", "neutral"),
                    regime=research.get("regime", "ranging"),
                    outcome="BLOCKED", confidence=confidence, reason=reason,
                    symbol=symbol, price=price,
                )
