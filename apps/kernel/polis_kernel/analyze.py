"""On-demand market analysis requested from the dashboard.

ANALYSIS ONLY — nothing in this module opens a position.

The automatic path (TRADE_SIGNAL → ResearchAgent → RESEARCH_COMPLETE →
SignalFilter → TradeHandler) ends in a live order, so this module deliberately
does *not* reuse ResearchAgent.handle() or _research(): publishing
RESEARCH_COMPLETE would hand the signal straight to the filter and fire a real
trade every time someone pressed "analyse" on the dashboard. It calls the same
LLM prompt and the same sizing helpers directly, then emits one ANALYZE_RESULT.

Every number it reports comes from the helpers the live trading path uses
(_calc_lots, _CONTRACT, the signal publisher's ATR config, the bridge's reward
ratio) so the preview matches what an actual order would do.
"""
import asyncio
import json
import logging
import os

import redis.asyncio as aioredis

from polis_llm import LLMClient

from .research_agent import _SYSTEM, _get_h4_bias, _get_world, _world_context
from .sentiment_fetcher import get_social_sentiment
from .signal_publisher import _DEFAULT_CFG, _SYMBOL_CONFIG
from .trade_handler import _CONTRACT, _DEFAULT_CONTRACT, _calc_lots

log = logging.getLogger("kernel.analyze")

_REDIS_URL     = os.getenv("REDIS_URL", "redis://redis:6379/0")
_REWARD_RATIO  = float(os.getenv("REWARD_RATIO", "3.0"))  # matches polis_mt5_bridge
_STOP_ATR_MULT = 1.5                                      # matches signal_publisher

# dashboard symbol ("XAUUSD") → signal publisher config ("XAU/USD" entry)
_CFG_BY_NAME: dict[str, dict] = {
    cfg["name"]: cfg for cfg in _SYMBOL_CONFIG.values() if cfg.get("name")
}

_DIRECTION_OF = {"bullish": "long", "bearish": "short"}

_llm: LLMClient | None = None


def _get_llm() -> LLMClient:
    global _llm
    if _llm is None:
        _llm = LLMClient()
    return _llm


async def _current_price(symbol: str) -> float:
    """Live mid price published by the MT5 bridge (polis:mt5_prices, 10s TTL)."""
    try:
        r = aioredis.from_url(_REDIS_URL, socket_timeout=2.0)
        raw = await r.get("polis:mt5_prices")
        await r.aclose()
        if not raw:
            return 0.0
        quote = json.loads(raw).get(symbol) or {}
        return float(quote.get("mid") or 0.0)
    except Exception as exc:
        log.warning("analyze: price lookup failed for %s: %s", symbol, exc)
        return 0.0


async def analyze(symbol: str, policy) -> dict:
    """Return a trade preview for `symbol` at the current moment.

    Never places an order. The caller publishes the result as ANALYZE_RESULT.
    """
    symbol = (symbol or "XAUUSD").upper().replace("/", "")

    price = await _current_price(symbol)
    if price <= 0:
        return {
            "symbol": symbol,
            "ok":     False,
            "error":  f"ไม่มีราคาสดของ {symbol} — ตรวจว่า MT5 bridge รันอยู่",
        }

    cfg    = _CFG_BY_NAME.get(symbol, _DEFAULT_CFG)
    atr    = round(price * cfg["atr"],    4)
    spread = round(price * cfg["spread"], 5)
    stop   = round(atr * _STOP_ATR_MULT,  4)
    risk   = round(stop / price, 5) if price else 0.0

    log.info("Analyze request: %s @ %.5g  ATR=%.5g", symbol, price, atr)

    # Same context the live research path assembles (all best-effort).
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
            _get_llm().complete_json(
                system=_SYSTEM,
                user=(
                    f"Signal: REVIEW {symbol} — no direction assumed, judge the market itself\n"
                    f"Price: {price:.5g}  ATR: {atr:.5g}  Spread: {spread:.5g}"
                    f"{ctx}"
                ),
            ),
            timeout=20.0,
        )
    except Exception as exc:
        log.warning("Analyze LLM error for %s: %s", symbol, exc)
        return {
            "symbol": symbol,
            "ok":     False,
            "error":  f"AI ไม่ตอบ: {exc}",
        }

    sentiment  = str(result.get("sentiment", "neutral")).lower()
    confidence = int(result.get("confidence", 50) or 50)
    regime     = str(result.get("regime", "ranging")).lower()
    factors    = [str(f) for f in (result.get("factors") or [])][:2]
    direction  = _DIRECTION_OF.get(sentiment, "")

    # Sizing through the live trading helpers so the preview cannot drift from
    # what TradeHandler would actually send.
    contract   = _CONTRACT.get(symbol, _DEFAULT_CONTRACT)
    lots       = _calc_lots(symbol=symbol, stop=stop, max_risk=policy.max_risk, atr=atr)
    risk_usd   = round(contract["risk_per_lot"](stop) * lots, 2)
    reward_usd = round(risk_usd * _REWARD_RATIO, 2)

    if direction == "long":
        sl, tp = round(price - stop, 5), round(price + stop * _REWARD_RATIO, 5)
    elif direction == "short":
        sl, tp = round(price + stop, 5), round(price - stop * _REWARD_RATIO, 5)
    else:
        sl = tp = 0.0

    # The filter's own bar, so the preview says the same thing the bot would.
    threshold   = await _confidence_threshold(symbol)
    recommended = bool(direction) and confidence >= threshold

    log.info(
        "Analyze complete: %s → %s conf=%d (bar %d) %s",
        symbol, direction or "no-trade", confidence, threshold,
        "RECOMMENDED" if recommended else "not recommended",
    )

    return {
        "symbol":      symbol,
        "ok":          True,
        "price":       price,
        "direction":   direction,
        "sentiment":   sentiment,
        "regime":      regime,
        "confidence":  confidence,
        "threshold":   threshold,
        "recommended": recommended,
        "factors":     factors,
        "atr":         atr,
        "spread":      spread,
        "stop":        stop,
        "risk":        risk,
        "sl":          sl,
        "tp":          tp,
        "lots":        lots,
        "risk_usd":    risk_usd,
        "reward_usd":  reward_usd,
        "max_risk":    policy.max_risk,
    }


async def _confidence_threshold(symbol: str) -> int:
    """The bar SignalFilter would apply: live global setting vs per-symbol floor.

    SignalFilter keeps the global value on its instance (changeable from the
    Settings page without a restart), so read the same persisted copy the
    gateway writes rather than the process default.
    """
    from .signal_filter import _MIN_CONFIDENCE, _SYM_MIN_CONFIDENCE  # noqa: PLC0415

    global_min = _MIN_CONFIDENCE
    try:
        # polis:settings is a Redis hash written with hset by the gateway —
        # a plain get() here raises WRONGTYPE and silently loses the live value.
        r = aioredis.from_url(_REDIS_URL, socket_timeout=2.0)
        stored = await r.hget("polis:settings", "min_confidence")
        await r.aclose()
        if stored is not None:
            global_min = int(float(stored))
    except Exception as exc:
        log.debug("analyze: settings lookup failed (%s) — using default bar", exc)

    return max(global_min, _SYM_MIN_CONFIDENCE.get(symbol, global_min))
