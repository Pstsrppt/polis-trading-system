"""Research Division: LLM market-context analysis + Qdrant memory recall."""
import asyncio
import json
import logging
import os
import time
from typing import TYPE_CHECKING

import redis.asyncio as aioredis

from polis_llm import LLMClient
from .cost_tracker import cost_tracker
from .sentiment_fetcher import get_social_sentiment

if TYPE_CHECKING:
    from .memory_store import MemoryStore

log = logging.getLogger("kernel.research")

_REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
_WORLD_KEY = "polis:world"

# Instrument-specific macro bias rules sent to the LLM
_SYMBOL_BIAS: dict[str, str] = {
    "XAUUSD": (
        "Gold (XAU/USD): safe-haven asset. Rallies in RISK-OFF and with weak DXY; "
        "falls with strong USD and RISK-ON. Extreme Fear supports safe-haven demand."
    ),
    "EURUSD": (
        "EUR/USD forex: falls when DXY rises (USD strength) and in RISK-OFF. "
        "Rallies with weak USD and RISK-ON. Strong DXY = direct bearish pressure."
    ),
    "GBPUSD": (
        "GBP/USD forex: inversely correlated with DXY. "
        "RISK-OFF typically weakens GBP alongside EUR."
    ),
    "BTCUSD": (
        "Bitcoin (BTC/USD): high-beta risk asset. Falls sharply in Extreme Fear (F&G<25) "
        "and RISK-ON with high greed. Expect volatile regime and wide ATR."
    ),
    "XAGUSD": (
        "Silver (XAG/USD): precious metal + industrial commodity. Highly correlated with Gold "
        "but more volatile (beta ~1.5x Gold). Rallies with weak USD, RISK-OFF, and industrial demand. "
        "Watch Gold/Silver ratio — ratio dropping = silver outperforming."
    ),
}

_SYSTEM = """You are the POLIS Research Agent covering gold, forex, and crypto signals.
Assess market context for the signal below and reply with JSON ONLY:
{"sentiment": "bullish"|"bearish"|"neutral", "regime": "trending"|"ranging"|"volatile", "confidence": 0-100, "factors": ["max 2 short phrases"]}

confidence guide: 80+ strong · 60-79 moderate · 40-59 uncertain · <40 weak
Be decisive — avoid 50 when evidence clearly points one way.
No markdown, no explanation outside JSON."""


_H4_CACHE: dict[str, tuple[float, str]] = {}   # symbol → (ts, bias_text)
_H4_TTL = 900   # 15 min cache

_YF_MAP = {
    "XAUUSD": "GC=F",
    "EURUSD": "EURUSD=X",
    "GBPUSD": "GBPUSD=X",
    "BTCUSD": "BTC-USD",
}


async def _get_h4_bias(symbol: str) -> str:
    """Fetch H4 EMA trend using yfinance. Returns short text bias or ''."""
    now = time.monotonic()
    cached = _H4_CACHE.get(symbol)
    if cached and now - cached[0] < _H4_TTL:
        return cached[1]

    ticker = _YF_MAP.get(symbol)
    if not ticker:
        return ""

    try:
        import yfinance as yf  # noqa: PLC0415
        import pandas as pd    # noqa: PLC0415

        loop = asyncio.get_event_loop()
        df = await loop.run_in_executor(
            None,
            lambda: yf.download(ticker, period="10d", interval="1h",
                                 progress=False, auto_adjust=True),
        )
        if df is None or len(df) < 20:
            return ""

        close  = df["Close"].squeeze()
        ema20  = close.ewm(span=20, adjust=False).mean()
        ema50  = close.ewm(span=50, adjust=False).mean()
        last_c = float(close.iloc[-1])
        last_e20 = float(ema20.iloc[-1])
        last_e50 = float(ema50.iloc[-1])

        if last_c > last_e20 > last_e50:
            bias = f"H4 trend: UPTREND (price {last_c:.4g} > EMA20 {last_e20:.4g} > EMA50 {last_e50:.4g})"
        elif last_c < last_e20 < last_e50:
            bias = f"H4 trend: DOWNTREND (price {last_c:.4g} < EMA20 {last_e20:.4g} < EMA50 {last_e50:.4g})"
        else:
            bias = f"H4 trend: SIDEWAYS (price {last_c:.4g}, EMA20 {last_e20:.4g}, EMA50 {last_e50:.4g})"

        _H4_CACHE[symbol] = (now, bias)
        return bias

    except Exception as exc:
        log.debug("H4 bias fetch failed for %s: %s", symbol, exc)
        return ""


async def _get_world() -> dict:
    """Fetch latest world model snapshot from Redis. Returns {} on failure."""
    try:
        r = aioredis.from_url(_REDIS_URL, socket_timeout=2.0)
        raw = await r.get(_WORLD_KEY)
        await r.aclose()
        return json.loads(raw) if raw else {}
    except Exception:
        return {}


def _world_context(symbol: str, world: dict) -> str:
    """Build a compact macro summary relevant to the given instrument."""
    if not world:
        return ""

    bias   = _SYMBOL_BIAS.get(symbol, "")
    regime = world.get("regime", "UNKNOWN")
    fg     = world.get("fg_value")
    fg_cls = world.get("fg_classification", "")
    dxy_chg = world.get("dxy_chg_pct")

    lines = []
    if bias:
        lines.append(f"\nInstrument bias: {bias}")
    lines.append(f"Market regime: {regime}")
    if fg is not None:
        lines.append(f"Fear & Greed: {fg}/100 ({fg_cls})")
    if dxy_chg is not None:
        lines.append(f"DXY today: {dxy_chg:+.2f}% ({'USD gaining' if dxy_chg > 0 else 'USD weakening'})")

    # Symbol-specific context
    if symbol == "XAUUSD":
        chg = world.get("gold_chg_pct")
        div = world.get("gold_dxy_divergence")
        if chg is not None:
            lines.append(f"Gold today: {chg:+.2f}%")
        if div is not None:
            lbl = "bullish gold" if div > 0.3 else ("bearish gold" if div < -0.3 else "neutral")
            lines.append(f"Gold/DXY divergence: {div:+.2f} ({lbl})")
    elif symbol in ("EURUSD", "GBPUSD"):
        chg = world.get("eur_chg_pct")
        if chg is not None:
            lines.append(f"EUR/USD today: {chg:+.2f}%")
    elif symbol == "BTCUSD":
        chg = world.get("btc_chg_pct")
        if chg is not None:
            lines.append(f"BTC today: {chg:+.2f}%")
        if fg is not None and fg < 25:
            lines.append("⚠ Extreme Fear — crypto historically under heavy selling pressure")

    return "\n".join(lines)


class ResearchAgent:
    def __init__(self, bus, memory: "MemoryStore | None" = None) -> None:
        self.bus        = bus
        self._llm       = LLMClient()
        self._mem       = memory
        self._in_flight: set[str] = set()   # symbols currently being researched
        bus.subscribe("TRADE_SIGNAL", self.handle)
        log.info("ResearchAgent online — subscribed to TRADE_SIGNAL%s",
                 " (memory enabled)" if memory else "")

    async def handle(self, data: dict) -> None:
        symbol    = data.get("symbol", "XAUUSD")
        price     = data.get("price", 0)
        direction = data.get("direction", "long")
        atr       = float(data.get("atr", 10))
        spread    = float(data.get("spread", 0.5))
        risk      = float(data.get("risk", 0))

        if symbol in self._in_flight:
            log.info("Research: %s already in-flight — skipping duplicate signal", symbol)
            return
        self._in_flight.add(symbol)
        try:
            await self._research(data, symbol, direction, price, atr, spread, risk)
        finally:
            self._in_flight.discard(symbol)

    async def _research(self, data: dict, symbol: str, direction: str,
                        price: float, atr: float, spread: float, risk: float) -> None:
        log.info("Research: analysing %s %s @ %.5g  ATR=%.5g",
                 direction.upper(), symbol, price, atr)

        # Fetch macro context + H4 bias + social sentiment (parallel, best-effort)
        world, h4_bias, social = await asyncio.gather(
            _get_world(),
            _get_h4_bias(symbol),
            get_social_sentiment(symbol),
        )
        ctx = _world_context(symbol, world)
        if h4_bias:
            ctx += f"\n{h4_bias}"
        if social:
            ctx += f"\n\nSocial & News:\n{social}"

        try:
            result = await asyncio.wait_for(
                self._llm.complete_json(
                    system=_SYSTEM,
                    user=(
                        f"Signal: {direction.upper()} {symbol}\n"
                        f"Price: {price:.5g}  ATR: {atr:.5g}  "
                        f"Spread: {spread:.5g}  Risk: {risk:.3%}"
                        f"{ctx}"
                    ),
                ),
                timeout=15.0,
            )
        except Exception as exc:
            log.warning("Research LLM error: %s — neutral fallback", exc)
            result = {
                "sentiment":  "neutral",
                "regime":     "ranging",
                "confidence": 50,
                "factors":    ["LLM unavailable"],
            }
        else:
            cost_tracker.record("gemini", agent="research")

        research = {
            "sentiment":  result.get("sentiment", "neutral"),
            "regime":     result.get("regime",    "ranging"),
            "confidence": result.get("confidence", 50),
            "factors":    result.get("factors",   []),
        }

        # ── memory recall (non-blocking, symbol-scoped) ───────────────
        memory_hits: list[dict] = []
        if self._mem:
            memory_hits = await self._mem.recall(
                direction=direction,
                risk=risk,
                atr=atr,
                spread=spread,
                sentiment=research["sentiment"],
                regime=research["regime"],
                symbol=symbol,
            )
            if memory_hits:
                log.info("Memory recall: %d similar past decisions for %s", len(memory_hits), symbol)

        log.info(
            "Research complete: sentiment=%s regime=%s conf=%s memory=%d",
            research["sentiment"], research["regime"], research["confidence"], len(memory_hits),
        )

        await self.bus.publish("RESEARCH_COMPLETE", {
            **data,
            "research": research,
            "memory":   memory_hits,
        })
