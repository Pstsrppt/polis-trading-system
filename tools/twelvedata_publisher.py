"""Twelve Data Real Signal Publisher — multi-instrument support.

Setup (run once):
    pip install requests redis python-dotenv

Run:
    python tools/twelvedata_publisher.py

Instruments controlled via .env:
    SIGNAL_SYMBOLS=XAU/USD,EUR/USD,BTC/USD   (default: XAU/USD)
"""
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import redis
import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("td_pub")

API_KEY   = os.environ["TWELVE_DATA_API_KEY"]
POLL_SECS = 60
BASE_URL  = "https://api.twelvedata.com"

# Parse symbols from env — default to gold only
_raw_symbols = os.getenv("SIGNAL_SYMBOLS", "XAU/USD")
SYMBOLS = [s.strip() for s in _raw_symbols.split(",") if s.strip()]

# Per-symbol config: ATR factor (% of price per hour) and spread factor
SYMBOL_CONFIG: dict[str, dict] = {
    "XAU/USD":  {"atr": 0.003,   "spread": 0.00005,  "name": "XAUUSD"},
    "EUR/USD":  {"atr": 0.0008,  "spread": 0.000015, "name": "EURUSD"},
    "GBP/USD":  {"atr": 0.0010,  "spread": 0.000020, "name": "GBPUSD"},
    "BTC/USD":  {"atr": 0.012,   "spread": 0.0002,   "name": "BTCUSD"},
    "ETH/USD":  {"atr": 0.015,   "spread": 0.0003,   "name": "ETHUSD"},
    "USD/JPY":  {"atr": 0.0006,  "spread": 0.000010, "name": "USDJPY"},
    "XAG/USD":  {"atr": 0.004,   "spread": 0.0001,   "name": "XAGUSD"},
}
DEFAULT_CONFIG = {"atr": 0.003, "spread": 0.00005, "name": None}


def _ema(closes: list[float], period: int) -> float:
    k, e = 2 / (period + 1), closes[0]
    for v in closes[1:]:
        e = v * k + e * (1 - k)
    return e


def fetch_price(symbol: str) -> float | None:
    try:
        r = requests.get(
            f"{BASE_URL}/price",
            params={"symbol": symbol, "apikey": API_KEY},
            timeout=5,
        )
        data = r.json()
        if "price" in data:
            return float(data["price"])
        log.warning("%s price: %s", symbol, data)
    except Exception as exc:
        log.error("%s fetch_price error: %s", symbol, exc)
    return None


def fetch_direction(symbol: str) -> str:
    try:
        r = requests.get(
            f"{BASE_URL}/time_series",
            params={"symbol": symbol, "interval": "1h", "outputsize": 30, "apikey": API_KEY},
            timeout=10,
        )
        data = r.json()
        if "values" not in data:
            return "long"
        bars   = list(reversed(data["values"]))
        closes = [float(b["close"]) for b in bars]
        fast   = _ema(closes, 5)
        slow   = _ema(closes, 20)
        return "long" if fast > slow else "short"
    except Exception as exc:
        log.warning("%s fetch_direction error: %s — defaulting long", symbol, exc)
        return "long"


def build_signal(symbol: str) -> dict | None:
    price = fetch_price(symbol)
    if not price:
        return None

    cfg       = SYMBOL_CONFIG.get(symbol, DEFAULT_CONFIG)
    name      = cfg["name"] or symbol.replace("/", "")
    direction = fetch_direction(symbol)
    atr_val   = round(price * cfg["atr"], 4)
    spread    = round(price * cfg["spread"], 5)
    stop      = round(atr_val * 1.5, 4)
    risk      = round(stop / price, 5)

    return {
        "symbol":    name,
        "direction": direction,
        "price":     round(price, 5),
        "risk":      risk,
        "stop":      stop,
        "atr":       atr_val,
        "spread":    spread,
        "source":    "twelvedata_live",
        "ts":        datetime.now(timezone.utc).isoformat(),
    }


def main() -> None:
    redis_url = (
        os.getenv("REDIS_URL", "redis://localhost:6379/0")
        .replace("redis://redis:", "redis://localhost:")
    )
    r = redis.from_url(redis_url, decode_responses=True)

    try:
        r.ping()
        log.info("Redis connected: %s", redis_url)
    except Exception as exc:
        log.error("Redis not reachable: %s — is Docker running?", exc)
        return

    log.info("Publishing %d instrument(s) every %ds: %s", len(SYMBOLS), POLL_SECS, ", ".join(SYMBOLS))

    while True:
        for symbol in SYMBOLS:
            try:
                sig = build_signal(symbol)
                if sig:
                    r.publish("TRADE_SIGNAL", json.dumps(sig))
                    log.info(
                        "► %s %s @ %.4f  ATR=%.2f  risk=%.3f%%",
                        sig["direction"].upper(), sig["symbol"],
                        sig["price"], sig["atr"], sig["risk"] * 100,
                    )
                else:
                    log.warning("%s — no price data, skipping", symbol)
            except Exception as exc:
                log.error("%s error: %s", symbol, exc)
            # Small gap between symbols to avoid API rate limits
            if len(SYMBOLS) > 1:
                time.sleep(2)

        time.sleep(POLL_SECS)


if __name__ == "__main__":
    main()
