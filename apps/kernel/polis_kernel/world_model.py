"""World Model — periodic macro data fetcher.

Fetches every WORLD_MODEL_INTERVAL seconds (default 1800s / 30 min):
  • Fear & Greed Index  (alternative.me — free, no key)
  • XAU/USD / DXY / EUR/USD / BTC/USD prices:
      Primary:  TwelveData /quote (uses API credits)
      Fallback: yfinance        (free, no key, no rate limit)

Results stored in Redis key polis:world (JSON string).
Published as WORLD_UPDATE event every cycle.
"""
import asyncio
import json
import logging
import os
from datetime import datetime, timezone

import httpx
import redis.asyncio as aioredis

log = logging.getLogger("kernel.world")

_REDIS_KEY  = "polis:world"
_TWELVE_KEY = os.getenv("TWELVE_DATA_API_KEY", "")
_INTERVAL   = int(os.getenv("WORLD_MODEL_INTERVAL", "1800"))

# Trading instruments + DXY macro indicator
_YF_MAP = {
    "XAU/USD": "GC=F",
    "DXY":     "DX-Y.NYB",
    "EUR/USD": "EURUSD=X",
    "BTC/USD": "BTC-USD",
}


def _fetch_yf_prices() -> dict[str, tuple[float, float]]:
    """Sync — returns {td_symbol: (last_price, prev_close)}. Run in executor."""
    import yfinance as yf  # noqa: PLC0415

    results: dict[str, tuple[float, float]] = {}
    for td_sym, yf_sym in _YF_MAP.items():
        try:
            fi = yf.Ticker(yf_sym).fast_info
            price = float(getattr(fi, "last_price",     None) or
                          getattr(fi, "lastPrice",       None) or 0)
            prev  = float(getattr(fi, "previous_close", None) or
                          getattr(fi, "previousClose",   None) or 0)
            if price > 0:
                results[td_sym] = (price, prev)
        except Exception as exc:
            log.debug("yfinance %s (%s) error: %s", td_sym, yf_sym, exc)
    return results


_DIVERGENCE_THRESHOLD = float(os.getenv("DIVERGENCE_ALERT_THRESHOLD", "1.0"))


class WorldModel:
    def __init__(self, bus, telegram_bot=None) -> None:
        self.bus            = bus
        self._tg            = telegram_bot
        self._redis_url     = os.getenv("REDIS_URL", "redis://redis:6379/0")
        self._last_div_alert: float | None = None   # timestamp of last divergence alert

    async def run(self) -> None:
        await asyncio.sleep(15)
        while True:
            try:
                data = await self._fetch()
                r = aioredis.from_url(self._redis_url)
                await r.set(_REDIS_KEY, json.dumps(data))
                await r.aclose()
                await self.bus.publish("WORLD_UPDATE", data)
                log.info(
                    "World model updated — gold=%.0f eur=%.4f btc=%.0f dxy=%.2f fg=%s/%s [src=%s]",
                    data.get("gold_price", 0),
                    data.get("eur_price",  0),
                    data.get("btc_price",  0),
                    data.get("dxy_price",  0),
                    data.get("fg_value",  "?"),
                    data.get("fg_classification", "?"),
                    data.get("_price_source", "?"),
                )
                await self._check_divergence(data)
            except Exception as exc:
                log.warning("World model error: %s", exc)
            await asyncio.sleep(_INTERVAL)

    async def _check_divergence(self, data: dict) -> None:
        """Alert when gold and DXY move in the same direction (unusual macro signal)."""
        div = data.get("gold_dxy_divergence")
        if div is None or abs(div) < _DIVERGENCE_THRESHOLD:
            return
        if not self._tg:
            return

        import time
        now = time.time()
        if self._last_div_alert and now - self._last_div_alert < _INTERVAL:
            return  # cooldown — one alert per world model cycle
        self._last_div_alert = now

        gold_chg = data.get("gold_chg_pct", 0) or 0
        dxy_chg  = data.get("dxy_chg_pct",  0) or 0
        gold_px  = data.get("gold_price",    0)
        fg       = data.get("fg_value",     "?")
        regime   = data.get("regime",       "?")
        direction = "📈 Gold ขึ้น + DXY ขึ้น" if gold_chg > 0 else "📉 Gold ลง + DXY ลง"
        en_dir    = "📈 Gold UP + DXY UP (safe-haven demand despite strong USD)" if gold_chg > 0 \
                    else "📉 Gold DOWN + DXY DOWN (unusual risk-on)"
        icon = "🚨" if abs(div) >= 2.0 else "⚠️"

        log.warning(
            "DIVERGENCE ALERT — gold/dxy divergence=%.2f%% (gold=%.1f%% dxy=%.1f%%)",
            div, gold_chg, dxy_chg,
        )
        try:
            await self._tg.notify(
                f"{icon}  <b>Macro Divergence Alert</b>\n\n"
                f"📐  Gold/DXY divergence:  <b>{div:+.2f}%</b>  (threshold ±{_DIVERGENCE_THRESHOLD}%)\n\n"
                f"🥇  Gold    <b>{gold_chg:+.2f}%</b>  @ ${gold_px:,.0f}\n"
                f"💵  DXY     <b>{dxy_chg:+.2f}%</b>\n"
                f"😨  F&G     <b>{fg}/100</b>\n"
                f"🌐  Regime  <b>{regime}</b>\n\n"
                f"สัญญาณ: {direction}\n\n"
                f"━━━━━━━━━━━━━━━━━━━━━━\n\n"
                f"{icon}  <b>Macro Divergence Alert</b>\n\n"
                f"📐  Gold/DXY divergence:  <b>{div:+.2f}%</b>\n"
                f"{en_dir}"
            )
        except Exception as exc:
            log.warning("Divergence alert Telegram failed: %s", exc)

    async def _fetch(self) -> dict:
        data: dict = {"ts": datetime.now(timezone.utc).isoformat()}

        async with httpx.AsyncClient(timeout=10.0) as client:
            # ── Fear & Greed (alternative.me — always free) ──────────
            try:
                r = await client.get("https://api.alternative.me/fng/?limit=1")
                fg = r.json()["data"][0]
                data["fg_value"]          = int(fg["value"])
                data["fg_classification"] = fg["value_classification"]
            except Exception as exc:
                log.debug("Fear&Greed fetch failed: %s", exc)

            # ── Price data: TwelveData → yfinance fallback ────────────
            price_data: dict[str, tuple[float, float]] = {}
            used_source = "none"

            if _TWELVE_KEY:
                td_ok = await self._fetch_twelvedata(client, price_data)
                if td_ok:
                    used_source = "twelvedata"

            if not price_data:
                try:
                    loop = asyncio.get_event_loop()
                    yf_data = await loop.run_in_executor(None, _fetch_yf_prices)
                    price_data.update(yf_data)
                    used_source = "yfinance" if yf_data else "none"
                except Exception as exc:
                    log.warning("yfinance fallback error: %s", exc)

            # DXY is not available on TwelveData free tier — always use yfinance for it
            if "DXY" not in price_data:
                try:
                    def _get_dxy_sync() -> tuple[float, float] | None:
                        import yfinance as yf  # noqa: PLC0415
                        fi = yf.Ticker("DX-Y.NYB").fast_info
                        price = float(getattr(fi, "last_price",     None) or
                                      getattr(fi, "lastPrice",       None) or 0)
                        prev  = float(getattr(fi, "previous_close", None) or
                                      getattr(fi, "previousClose",   None) or 0)
                        return (price, prev) if price > 0 else None
                    loop = asyncio.get_event_loop()
                    dxy_result = await loop.run_in_executor(None, _get_dxy_sync)
                    if dxy_result:
                        price_data["DXY"] = dxy_result
                        log.debug("DXY fetched via yfinance: %.2f", dxy_result[0])
                except Exception as exc:
                    log.debug("DXY yfinance fallback failed: %s", exc)

        # Map price data into named fields
        field_map = {
            "XAU/USD": ("gold_price", "gold_prev"),
            "DXY":     ("dxy_price",  "dxy_prev"),
            "EUR/USD": ("eur_price",  "eur_prev"),
            "BTC/USD": ("btc_price",  "btc_prev"),
        }
        for sym, (price_f, prev_f) in field_map.items():
            if sym in price_data:
                data[price_f] = price_data[sym][0]
                data[prev_f]  = price_data[sym][1]

        data["_price_source"] = used_source

        # ── Derived change % ──────────────────────────────────────────
        def _chg(price, prev):
            if price and prev and prev != 0:
                return round((price - prev) / prev * 100, 3)
            return None

        data["gold_chg_pct"] = _chg(data.get("gold_price"), data.get("gold_prev"))
        data["dxy_chg_pct"]  = _chg(data.get("dxy_price"),  data.get("dxy_prev"))
        data["eur_chg_pct"]  = _chg(data.get("eur_price"),  data.get("eur_prev"))
        data["btc_chg_pct"]  = _chg(data.get("btc_price"),  data.get("btc_prev"))

        # ── Market regime: RISK-ON / RISK-OFF / NEUTRAL ───────────────
        fg    = data.get("fg_value")
        dxc   = data.get("dxy_chg_pct")
        goldc = data.get("gold_chg_pct")
        if fg is not None and dxc is not None and goldc is not None:
            score = 0
            if fg >= 60:     score += 1
            elif fg <= 40:   score -= 1
            if dxc < -0.1:   score += 1   # weak dollar → risk-on
            elif dxc > 0.1:  score -= 1
            if goldc > 0.3:   score -= 1  # gold rally → safe-haven → risk-off
            elif goldc < -0.3: score += 1
            data["regime"] = "RISK-ON" if score >= 2 else "RISK-OFF" if score <= -2 else "NEUTRAL"
        else:
            data["regime"] = "UNKNOWN"

        # Gold/DXY divergence
        goldc = data.get("gold_chg_pct")
        dxc   = data.get("dxy_chg_pct")
        if goldc is not None and dxc is not None:
            data["gold_dxy_divergence"] = round(goldc - (-dxc), 3)

        return data

    async def _fetch_twelvedata(
        self, client: httpx.AsyncClient, out: dict[str, tuple[float, float]]
    ) -> bool:
        """Fetch price quotes from TwelveData. Returns True if any succeeded."""
        ok = False
        for sym in ("XAU/USD", "DXY", "EUR/USD", "BTC/USD"):
            try:
                r = await client.get(
                    "https://api.twelvedata.com/quote",
                    params={"symbol": sym, "apikey": _TWELVE_KEY},
                )
                q = r.json()
                if q.get("status") == "error" or q.get("code") == 429:
                    log.debug("TwelveData %s error/429: %s", sym, q.get("message", ""))
                    continue
                price = float(q.get("close") or 0)
                prev  = float(q.get("previous_close") or 0)
                if price > 0:
                    out[sym] = (price, prev)
                    ok = True
            except Exception as exc:
                log.debug("TwelveData %s failed: %s", sym, exc)
        return ok
