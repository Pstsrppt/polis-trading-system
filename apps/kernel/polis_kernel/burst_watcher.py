"""React to gaps and bursts of activity instead of waiting for the next poll.

The signal publisher asks TwelveData for prices on a fixed cycle (30 minutes at
the free tier's credit budget). A weekend gap, a news spike or a sudden run all
happen inside that window and are gone before the next poll looks.

The MT5 bridge already writes live prices to Redis every second, which costs no
API credits at all. This watcher reads them, keeps a short rolling window per
symbol, and when price travels far enough fast enough it dispatches a
TRADE_SIGNAL immediately — the same event the poller produces, so every filter,
the policy engine and the circuit breaker still apply exactly as before.

It proposes the direction price is already moving: a burst is momentum, and the
research agent and the filters remain free to decline it.
"""
import asyncio
import json
import logging
import os
import time
from collections import deque

import redis.asyncio as aioredis

log = logging.getLogger("kernel.burst")

_REDIS_URL   = os.getenv("REDIS_URL", "redis://redis:6379/0")
_PRICES_KEY  = "polis:mt5_prices"

_CHECK_S     = float(os.getenv("BURST_CHECK_SECONDS", "10"))     # how often we look
_WINDOW_S    = float(os.getenv("BURST_WINDOW_SECONDS", "900"))   # 15 min of history
_TRIGGER_ATR = float(os.getenv("BURST_TRIGGER_ATR", "0.75"))     # move, in ATRs
_COOLDOWN_S  = float(os.getenv("BURST_COOLDOWN_SECONDS", "1200"))
_STOP_ATR    = float(os.getenv("STOP_ATR_MULT", "3.0"))

# Same per-symbol ATR fractions the publisher uses, keyed by dashboard symbol.
_ATR_PCT = {
    "XAUUSD": 0.003, "EURUSD": 0.0008, "GBPUSD": 0.0010,
    "BTCUSD": 0.003, "XAGUSD": 0.004,
}
_SPREAD_PCT = {
    "XAUUSD": 0.00005, "EURUSD": 0.000015, "GBPUSD": 0.000020,
    "BTCUSD": 0.0002,  "XAGUSD": 0.0001,
}


class BurstWatcher:
    def __init__(self, bus) -> None:
        self.bus = bus
        self._hist: dict[str, deque] = {}
        self._last_fire: dict[str, float] = {}

    async def run(self) -> None:
        log.info(
            "BurstWatcher online — trigger at %.2f×ATR within %.0fs, "
            "cooldown %.0fs, checking every %.0fs",
            _TRIGGER_ATR, _WINDOW_S, _COOLDOWN_S, _CHECK_S,
        )
        r = aioredis.from_url(_REDIS_URL, socket_timeout=5.0)
        while True:
            try:
                await self._tick(r)
            except Exception as exc:
                log.warning("BurstWatcher tick failed: %s", exc)
            await asyncio.sleep(_CHECK_S)

    async def _tick(self, r) -> None:
        raw = await r.get(_PRICES_KEY)
        if not raw:
            return                      # bridge down; nothing to watch
        prices = json.loads(raw)
        now = time.time()

        for symbol, quote in prices.items():
            mid = float(quote.get("mid") or 0)
            if mid <= 0:
                continue

            hist = self._hist.setdefault(symbol, deque())
            hist.append((now, mid))
            while hist and now - hist[0][0] > _WINDOW_S:
                hist.popleft()
            if len(hist) < 3:
                continue

            atr = mid * _ATR_PCT.get(symbol, 0.003)
            if atr <= 0:
                continue

            oldest = hist[0][1]
            move = mid - oldest
            if abs(move) < _TRIGGER_ATR * atr:
                continue

            if now - self._last_fire.get(symbol, 0) < _COOLDOWN_S:
                continue
            self._last_fire[symbol] = now

            direction = "long" if move > 0 else "short"
            stop = round(atr * _STOP_ATR, 5)
            signal = {
                "symbol":    symbol,
                "direction": direction,
                "price":     round(mid, 5),
                "atr":       round(atr, 5),
                "spread":    round(mid * _SPREAD_PCT.get(symbol, 0.00005), 5),
                "stop":      stop,
                "risk":      round(stop / mid, 5) if mid else 0,
                "source":    "burst",
            }
            log.info(
                "⚡ BURST %s %s — moved %.5g (%.2f×ATR) in %.0fs @ %.5g",
                direction.upper(), symbol, move, abs(move) / atr,
                now - hist[0][0], mid,
            )
            await self.bus.dispatch("TRADE_SIGNAL", signal)
