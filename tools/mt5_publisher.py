"""
MT5 Real Signal Publisher — runs on Windows alongside MetaTrader5 terminal.

Reads XAUUSD M5 bars, computes EMA(5/20) crossover + ATR(14) signal,
publishes TRADE_SIGNAL to Redis every 60s so the POLIS kernel picks it up.

Setup (run once):
    pip install MetaTrader5 redis python-dotenv

Run:
    python tools/mt5_publisher.py
"""
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import MetaTrader5 as mt5
import redis
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("mt5_pub")

# ── config ────────────────────────────────────────────────────────────────────
SYMBOL     = "XAUUSD"
TIMEFRAME  = mt5.TIMEFRAME_M5
EMA_FAST   = 5
EMA_SLOW   = 20
ATR_PERIOD = 14
INTERVAL   = 60          # seconds between signals


# ── helpers ───────────────────────────────────────────────────────────────────
def _ema(closes: list[float], period: int) -> float:
    k, e = 2 / (period + 1), closes[0]
    for v in closes[1:]:
        e = v * k + e * (1 - k)
    return e


def _atr(bars, period: int = 14) -> float:
    trs = [
        max(b["high"] - b["low"],
            abs(b["high"] - bars[i - 1]["close"]),
            abs(b["low"]  - bars[i - 1]["close"]))
        for i, b in enumerate(bars)
        if i > 0
    ]
    return sum(trs[-period:]) / period


# ── MT5 ───────────────────────────────────────────────────────────────────────
def connect_mt5() -> bool:
    login    = int(os.environ["MT5_LOGIN"])
    password = os.environ["MT5_PASSWORD"]
    server   = os.environ["MT5_SERVER"]

    if not mt5.initialize():
        log.error("mt5.initialize() failed: %s", mt5.last_error())
        return False

    if not mt5.login(login=login, password=password, server=server):
        log.error("mt5.login() failed: %s", mt5.last_error())
        mt5.shutdown()
        return False

    info = mt5.account_info()
    log.info("MT5 connected — #%d  %s  balance $%.2f", info.login, info.server, info.balance)
    return True


def get_signal() -> dict | None:
    needed = EMA_SLOW + ATR_PERIOD + 10
    bars   = mt5.copy_rates_from_pos(SYMBOL, TIMEFRAME, 0, needed)
    if bars is None or len(bars) < needed:
        log.warning("Not enough bars (%s): %s", len(bars) if bars is not None else 0, mt5.last_error())
        return None

    closes    = [float(b["close"]) for b in bars]
    fast      = _ema(closes, EMA_FAST)
    slow      = _ema(closes, EMA_SLOW)
    atr_val   = _atr(bars, ATR_PERIOD)

    tick = mt5.symbol_info_tick(SYMBOL)
    if tick is None:
        log.warning("No tick data for %s", SYMBOL)
        return None

    price     = round(float(tick.ask), 2)
    spread    = round(float(tick.ask - tick.bid), 2)
    stop      = round(atr_val * 1.5, 2)                  # 1.5x ATR stop distance
    risk      = round((stop / price) if price else 0, 5) # stop as fraction of price
    direction = "long" if fast > slow else "short"

    return {
        "symbol":    SYMBOL,
        "direction": direction,
        "price":     price,
        "risk":      risk,
        "stop":      stop,
        "atr":       round(atr_val, 2),
        "spread":    spread,
        "source":    "mt5_live",
        "ts":        datetime.now(timezone.utc).isoformat(),
    }


# ── main ──────────────────────────────────────────────────────────────────────
def main() -> None:
    if not connect_mt5():
        sys.exit(1)

    # Redis is in Docker but port-mapped to localhost:6379
    redis_url = (
        os.getenv("REDIS_URL", "redis://localhost:6379/0")
        .replace("redis://redis:", "redis://localhost:")   # swap Docker hostname → localhost
    )
    r = redis.from_url(redis_url, decode_responses=True)
    log.info("Redis: %s", redis_url)
    log.info("Publishing %s M5 signals every %ds…  (Ctrl+C to stop)", SYMBOL, INTERVAL)

    try:
        while True:
            sig = get_signal()
            if sig:
                r.publish("TRADE_SIGNAL", json.dumps(sig))
                log.info(
                    "► %s %s @ %.2f  risk=%.3f%%  ATR=%.1f  spread=%.2f",
                    sig["direction"].upper(), SYMBOL,
                    sig["price"], sig["risk"] * 100,
                    sig["atr"], sig["spread"],
                )
            else:
                log.warning("Signal skipped — retrying next interval")
            time.sleep(INTERVAL)
    except KeyboardInterrupt:
        log.info("Stopped by user.")
    finally:
        mt5.shutdown()
        log.info("MT5 disconnected.")


if __name__ == "__main__":
    main()
