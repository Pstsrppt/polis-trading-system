"""Mock multi-symbol signal generator — keeps the system alive during development.

Publishes a TRADE_SIGNAL for each configured symbol in sequence.
Mirrors the same symbol config as TwelveDataPublisher so the full
multi-symbol pipeline (research, filter, trade_handler, tracker) is exercised.
"""
import asyncio
import random
from datetime import datetime, timezone

# Price ranges and ATR fractions per symbol — match signal_publisher.py
_MOCK_CONFIG: dict[str, dict] = {
    "XAUUSD": {
        "price_base": 2320, "price_range": 80,
        "atr_frac": 0.003,  "spread_frac": 0.00005,
    },
    "EURUSD": {
        "price_base": 1.085, "price_range": 0.015,
        "atr_frac": 0.0008,  "spread_frac": 0.000015,
    },
    "BTCUSD": {
        "price_base": 62_000, "price_range": 3_000,
        "atr_frac": 0.003,    "spread_frac": 0.0002,
    },
}

import os as _os
_RAW = _os.getenv("SIGNAL_SYMBOLS", "XAU/USD")
_SYMBOL_NAME_MAP = {
    "XAU/USD": "XAUUSD", "EUR/USD": "EURUSD",
    "GBP/USD": "GBPUSD", "BTC/USD": "BTCUSD", "XAG/USD": "XAGUSD",
}
# Build active symbols list from env, mapped to internal names
_ACTIVE = [
    _SYMBOL_NAME_MAP.get(s.strip(), s.strip().replace("/", ""))
    for s in _RAW.split(",") if s.strip()
]
# Keep only symbols that have mock config; fall back to XAUUSD if none match
_SYMBOLS = [s for s in _ACTIVE if s in _MOCK_CONFIG] or ["XAUUSD"]


class MockTradingSignals:
    def __init__(self, bus, interval: float = 60.0) -> None:
        self.bus      = bus
        self.interval = interval

    async def run(self) -> None:
        await asyncio.sleep(6)   # let executive board boot first
        import logging
        log = logging.getLogger("kernel.mock")
        log.info("MockTradingSignals started — symbols: %s", ", ".join(_SYMBOLS))

        while True:
            for sym in _SYMBOLS:
                cfg   = _MOCK_CONFIG[sym]
                price = round(cfg["price_base"] + random.uniform(-cfg["price_range"], cfg["price_range"]), 5)
                atr   = round(price * cfg["atr_frac"], 5)
                spread= round(price * cfg["spread_frac"], 6)
                stop  = round(atr * random.uniform(0.8, 2.2), 5)
                risk  = round(stop / price, 5)

                await self.bus.publish("TRADE_SIGNAL", {
                    "symbol":    sym,
                    "direction": random.choice(["long", "short"]),
                    "price":     price,
                    "risk":      risk,
                    "stop":      stop,
                    "atr":       atr,
                    "spread":    spread,
                    "source":    "mock",
                    "ts":        datetime.now(timezone.utc).isoformat(),
                })

                if len(_SYMBOLS) > 1:
                    await asyncio.sleep(2)   # stagger multi-symbol signals

            await asyncio.sleep(self.interval)
