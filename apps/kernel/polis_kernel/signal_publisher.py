"""TwelveData live signal publisher — runs as a kernel coroutine.

Activated when SIGNAL_SOURCE=twelvedata.
Uses EMA(5/20) crossover on 1h bars to determine direction.
Falls back to yfinance when TwelveData is unavailable (429, no key, etc.)
Publishes directly to the in-process event bus (no Redis round-trip).
"""
import asyncio
import logging
import os
from datetime import datetime, timezone

import httpx

log = logging.getLogger("kernel.td_pub")

_API_KEY  = os.getenv("TWELVE_DATA_API_KEY", "")
_BASE_URL = "https://api.twelvedata.com"
_POLL_S   = int(os.getenv("TD_POLL_SECONDS", "60"))

_RAW = os.getenv("SIGNAL_SYMBOLS", "XAU/USD")
SYMBOLS = [s.strip() for s in _RAW.split(",") if s.strip()]

_SYMBOL_CONFIG: dict[str, dict] = {
    "XAU/USD": {"atr": 0.003,  "spread": 0.00005,  "name": "XAUUSD"},
    "EUR/USD": {"atr": 0.0008, "spread": 0.000015, "name": "EURUSD"},
    "GBP/USD": {"atr": 0.0010, "spread": 0.000020, "name": "GBPUSD"},
    "BTC/USD": {"atr": 0.003,  "spread": 0.0002,   "name": "BTCUSD"},
    "XAG/USD": {"atr": 0.004,  "spread": 0.0001,   "name": "XAGUSD"},
}
_DEFAULT_CFG = {"atr": 0.003, "spread": 0.00005, "name": None}

_YF_SYM: dict[str, str] = {
    "XAU/USD": "GC=F",
    "EUR/USD": "EURUSD=X",
    "GBP/USD": "GBPUSD=X",
    "BTC/USD": "BTC-USD",
    "XAG/USD": "SI=F",
}


def _ema(closes: list[float], period: int) -> float:
    k, e = 2 / (period + 1), closes[0]
    for v in closes[1:]:
        e = v * k + e * (1 - k)
    return e


def _yf_fetch_sync(symbol: str) -> tuple[float, str] | None:
    """Sync — fetch price + EMA(5/20) direction from yfinance. Run in executor."""
    import yfinance as yf  # noqa: PLC0415

    yf_sym = _YF_SYM.get(symbol)
    if not yf_sym:
        return None
    try:
        ticker = yf.Ticker(yf_sym)
        fi = ticker.fast_info
        price = float(
            getattr(fi, "last_price", None) or
            getattr(fi, "lastPrice",  None) or 0
        )
        if price <= 0:
            return None
        hist = ticker.history(period="3d", interval="1h")
        if len(hist) >= 20:
            closes    = hist["Close"].tolist()
            direction = "long" if _ema(closes, 5) > _ema(closes, 20) else "short"
        else:
            direction = "long"
        return price, direction
    except Exception as exc:
        log.debug("yfinance %s (%s): %s", symbol, yf_sym, exc)
        return None


class TwelveDataPublisher:
    def __init__(self, bus) -> None:
        self.bus = bus
        if not _API_KEY:
            log.warning("TWELVE_DATA_API_KEY not set — all signals via yfinance")

    async def run(self) -> None:
        await asyncio.sleep(10)
        log.info(
            "TwelveDataPublisher started — %d symbol(s), poll every %ds: %s",
            len(SYMBOLS), _POLL_S, ", ".join(SYMBOLS),
        )
        while True:
            for symbol in SYMBOLS:
                try:
                    sig = await self._build_signal(symbol)
                    if sig:
                        await self.bus.dispatch("TRADE_SIGNAL", sig)
                        log.info(
                            "[%s] ► %s %s @ %.4f  ATR=%.2f  risk=%.3f%%",
                            sig["source"], sig["direction"].upper(), sig["symbol"],
                            sig["price"], sig["atr"], sig["risk"] * 100,
                        )
                except Exception as exc:
                    log.error("Signal %s error: %s", symbol, exc)
                if len(SYMBOLS) > 1:
                    await asyncio.sleep(2)
            await asyncio.sleep(_POLL_S)

    async def _fetch_price(self, symbol: str, client: httpx.AsyncClient) -> float | None:
        try:
            r = await client.get(
                f"{_BASE_URL}/price",
                params={"symbol": symbol, "apikey": _API_KEY},
                timeout=8.0,
            )
            data = r.json()
            if "price" in data:
                return float(data["price"])
            log.warning("%s price response: %s", symbol, data)
        except Exception as exc:
            log.error("%s fetch_price: %s", symbol, exc)
        return None

    async def _fetch_direction(self, symbol: str, client: httpx.AsyncClient) -> str:
        try:
            r = await client.get(
                f"{_BASE_URL}/time_series",
                params={"symbol": symbol, "interval": "1h", "outputsize": 30, "apikey": _API_KEY},
                timeout=12.0,
            )
            data = r.json()
            if "values" not in data:
                return "long"
            bars   = list(reversed(data["values"]))
            closes = [float(b["close"]) for b in bars]
            return "long" if _ema(closes, 5) > _ema(closes, 20) else "short"
        except Exception as exc:
            log.warning("%s fetch_direction: %s — defaulting long", symbol, exc)
            return "long"

    async def _build_yf_signal(self, symbol: str) -> dict | None:
        loop   = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, _yf_fetch_sync, symbol)
        if not result:
            log.warning("%s: yfinance fallback failed — no signal", symbol)
            return None
        price_f, direction = result
        cfg    = _SYMBOL_CONFIG.get(symbol, _DEFAULT_CFG)
        name   = cfg["name"] or symbol.replace("/", "")
        atr    = round(price_f * cfg["atr"],    4)
        spread = round(price_f * cfg["spread"], 5)
        stop   = round(atr * 1.5, 4)
        risk   = round(stop / price_f, 5)
        return {
            "symbol":    name,
            "direction": direction,
            "price":     round(price_f, 5),
            "risk":      risk,
            "stop":      stop,
            "atr":       atr,
            "spread":    spread,
            "source":    "yfinance_live",
            "ts":        datetime.now(timezone.utc).isoformat(),
        }

    async def _build_signal(self, symbol: str) -> dict | None:
        if not _API_KEY:
            return await self._build_yf_signal(symbol)

        async with httpx.AsyncClient() as client:
            price = await self._fetch_price(symbol, client)
            if not price:
                log.info("%s TwelveData unavailable — falling back to yfinance", symbol)
                return await self._build_yf_signal(symbol)
            direction = await self._fetch_direction(symbol, client)

        cfg     = _SYMBOL_CONFIG.get(symbol, _DEFAULT_CFG)
        name    = cfg["name"] or symbol.replace("/", "")
        price_f = float(price)
        atr     = round(price_f * cfg["atr"],    4)
        spread  = round(price_f * cfg["spread"], 5)
        stop    = round(atr * 1.5, 4)
        risk    = round(stop / price_f, 5)
        return {
            "symbol":    name,
            "direction": direction,
            "price":     round(price_f, 5),
            "risk":      risk,
            "stop":      stop,
            "atr":       atr,
            "spread":    spread,
            "source":    "twelvedata_live",
            "ts":        datetime.now(timezone.utc).isoformat(),
        }
