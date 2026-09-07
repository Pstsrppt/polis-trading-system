"""Signal Filter: rejects low-quality signals before TradeHandler sees them.

Checks (all configurable via env):
  MIN_SIGNAL_CONFIDENCE  — research confidence must be >= this (default 60)
  MIN_ATR_SPREAD_RATIO   — ATR must be >= N× the spread (default 2.0)
  TRADING_HOURS_START    — UTC hour to start accepting signals (default 7)
  TRADING_HOURS_END      — UTC hour to stop  accepting signals (default 20)
  CORR_MAX_SAME_DIR      — max open positions in the same direction per
                           correlation group before blocking (default 1)

Pass → publishes SIGNAL_APPROVED
Fail → publishes SIGNAL_REJECTED  (payload + rejected_reasons list)
"""
import json
import logging
import os
import time
from datetime import datetime, timezone, timedelta

import redis.asyncio as aioredis

log = logging.getLogger("kernel.filter")

_ACTIVE_SYMBOLS_KEY  = "polis:active_symbols"
_NEWS_EVENTS_KEY     = "polis:news_events"   # Redis key for manual news events
_REDIS_URL           = os.getenv("REDIS_URL", "redis://redis:6379/0")
_NEWS_BUFFER_MINUTES = int(os.getenv("NEWS_BUFFER_MINUTES", "30"))
_FF_CALENDAR_URL     = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"

# High-impact event keywords to filter
_NEWS_KEYWORDS = {
    "Non-Farm", "NFP", "CPI", "Core CPI", "FOMC", "Fed", "Interest Rate",
    "GDP", "PCE", "PPI", "Unemployment", "Payroll", "PMI Flash",
    "BoE", "ECB", "BOJ", "RBA", "SNB",
}

_MIN_CONFIDENCE  = int(os.getenv("MIN_SIGNAL_CONFIDENCE",  "60"))
_MIN_ATR_SPREAD  = float(os.getenv("MIN_ATR_SPREAD_RATIO", "2.0"))
_HOUR_START      = int(os.getenv("TRADING_HOURS_START",    "7"))   # 07 UTC = 14:00 Thai
_HOUR_END        = int(os.getenv("TRADING_HOURS_END",      "20"))  # 20 UTC = 03:00 Thai
_CORR_MAX        = int(os.getenv("CORR_MAX_SAME_DIR",      "1"))

# Per-symbol minimum confidence — volatile assets need higher conviction
_SYM_MIN_CONFIDENCE: dict[str, int] = {
    "BTCUSD": 85,
    "XAGUSD": 80,
}

# Correlation groups — instruments that move together
# Positions within the same group are considered correlated
_CORR_GROUPS: list[frozenset[str]] = [
    frozenset({"XAUUSD", "XAGUSD"}),                   # precious metals
    frozenset({"EURUSD", "GBPUSD", "GBPEUR"}),         # European FX
    frozenset({"BTCUSD", "ETHUSD"}),                    # crypto
    frozenset({"USDJPY", "USDCHF"}),                    # USD safe-haven
]


def _corr_group(symbol: str) -> frozenset[str] | None:
    for g in _CORR_GROUPS:
        if symbol.upper() in g:
            return g
    return None


class SignalFilter:
    def __init__(self, bus, telegram_bot=None, circuit_breaker=None, policy=None) -> None:
        self._bus    = bus
        self._tg     = telegram_bot
        self._cb     = circuit_breaker
        self._policy = policy
        self._open: dict[str, str] = {}   # symbol → direction for open positions
        self._sym_cache: dict[str, bool] = {}
        self._sym_cache_ts: float = 0
        self._news_cache: list[dict] = []
        self._news_cache_ts: float = 0

        # Live-updatable thresholds (can be changed via Settings page without restart)
        self._min_confidence = _MIN_CONFIDENCE
        self._min_atr_spread = _MIN_ATR_SPREAD
        self._hour_start     = _HOUR_START
        self._hour_end       = _HOUR_END

        bus.subscribe("RESEARCH_COMPLETE", self._on_research)
        bus.subscribe("TRADE_APPROVED",    self._on_approved)
        bus.subscribe("TRADE_CLOSED",      self._on_closed)
        bus.subscribe("SETTINGS_UPDATE",   self._on_settings_update)

        log.info(
            "SignalFilter ready — conf≥%d%%  atr/spread≥%.1fx  "
            "hours=%02d:00–%02d:00 UTC  corr_max=%d",
            self._min_confidence, self._min_atr_spread,
            self._hour_start, self._hour_end, _CORR_MAX,
        )

    # ── position tracking ─────────────────────────────────────────
    async def _on_approved(self, data: dict) -> None:
        sym = str(data.get("symbol", "")).upper()
        dir_ = str(data.get("direction", "")).lower()
        if sym:
            self._open[sym] = dir_

    async def _on_closed(self, data: dict) -> None:
        sym = str(data.get("symbol", "")).upper()
        self._open.pop(sym, None)

    async def _on_settings_update(self, data: dict) -> None:
        """Apply live settings changes from dashboard without kernel restart."""
        changed = []
        if "min_confidence" in data:
            self._min_confidence = int(data["min_confidence"])
            changed.append(f"conf≥{self._min_confidence}%")
        if "atr_ratio" in data:
            self._min_atr_spread = float(data["atr_ratio"])
            changed.append(f"atr/spread≥{self._min_atr_spread:.1f}x")
        if "trading_hours_start" in data:
            self._hour_start = int(data["trading_hours_start"])
            changed.append(f"start={self._hour_start:02d}:00")
        if "trading_hours_end" in data:
            self._hour_end = int(data["trading_hours_end"])
            changed.append(f"end={self._hour_end:02d}:00")
        if changed:
            log.info("SignalFilter settings updated: %s", "  ".join(changed))

    async def _fetch_news_events(self) -> list[dict]:
        """Fetch high-impact events from ForexFactory + Redis manual events. Cache 1hr."""
        now = time.monotonic()
        if now - self._news_cache_ts < 3600:
            return self._news_cache

        events: list[dict] = []

        # 1. ForexFactory calendar
        try:
            import httpx  # noqa: PLC0415
            async with httpx.AsyncClient(timeout=8.0) as client:
                r = await client.get(_FF_CALENDAR_URL, headers={"User-Agent": "POLIS/1.0"})
                if r.status_code == 200:
                    for ev in r.json():
                        title = ev.get("title", "") or ev.get("name", "")
                        impact = ev.get("impact", "").lower()
                        date_str = ev.get("date", "")
                        if impact not in ("high",):
                            continue
                        if not any(kw.lower() in title.lower() for kw in _NEWS_KEYWORDS):
                            continue
                        try:
                            dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
                            events.append({"title": title, "dt": dt})
                        except Exception:
                            pass
        except Exception as exc:
            log.debug("FF calendar fetch failed: %s", exc)

        # 2. Manual events from Redis
        try:
            r = aioredis.from_url(_REDIS_URL, socket_timeout=2.0)
            raw = await r.get(_NEWS_EVENTS_KEY)
            await r.aclose()
            if raw:
                for ev in json.loads(raw):
                    try:
                        dt = datetime.fromisoformat(ev["dt"])
                        events.append({"title": ev.get("title", "Manual"), "dt": dt})
                    except Exception:
                        pass
        except Exception:
            pass

        self._news_cache    = events
        self._news_cache_ts = now
        log.info("NewsFilter: loaded %d high-impact events", len(events))
        return events

    async def _is_near_news(self) -> str | None:
        """Return event title if within ±NEWS_BUFFER_MINUTES of a high-impact event, else None."""
        if _NEWS_BUFFER_MINUTES <= 0:
            return None
        now    = datetime.now(timezone.utc)
        buf    = timedelta(minutes=_NEWS_BUFFER_MINUTES)
        events = await self._fetch_news_events()
        for ev in events:
            dt = ev["dt"]
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if abs((now - dt).total_seconds()) <= buf.total_seconds():
                return ev["title"]
        return None

    async def _is_symbol_active(self, symbol: str) -> bool:
        """Check Redis active_symbols config with 30s in-memory cache."""
        now = time.monotonic()
        if now - self._sym_cache_ts < 30:
            return self._sym_cache.get(symbol, True)
        try:
            r   = aioredis.from_url(_REDIS_URL, socket_timeout=2.0)
            raw = await r.get(_ACTIVE_SYMBOLS_KEY)
            await r.aclose()
            self._sym_cache    = json.loads(raw) if raw else {}
            self._sym_cache_ts = now
        except Exception:
            pass
        return self._sym_cache.get(symbol, True)

    # ── main filter ───────────────────────────────────────────────
    async def _on_research(self, data: dict) -> None:
        if self._policy and self._policy.paused:
            log.info("SIGNAL_SKIPPED — trading paused by dashboard")
            return
        if self._tg and self._tg.is_paused():
            log.info("SIGNAL_SKIPPED — bot paused")
            return
        if self._cb and self._cb.is_triggered():
            log.warning("SIGNAL_SKIPPED — circuit breaker: %s", self._cb._reason)
            return

        research   = data.get("research", {})
        confidence = int(research.get("confidence", 0))
        atr        = float(data.get("atr", 0))
        spread     = float(data.get("spread", 1))
        symbol     = str(data.get("symbol", "XAUUSD")).upper()

        if not await self._is_symbol_active(symbol):
            log.info("SIGNAL_SKIPPED — %s disabled via dashboard", symbol)
            return
        direction  = str(data.get("direction", "")).lower()

        reasons: list[str] = []

        # ── 0. news filter ───────────────────────────────────────
        near_event = await self._is_near_news()
        if near_event:
            log.info(
                "SIGNAL_SKIPPED (news) %s — within %dmin of '%s'",
                symbol, _NEWS_BUFFER_MINUTES, near_event,
            )
            if self._tg:
                try:
                    await self._tg.notify(
                        f"📰  <b>News Filter Active</b>\n\n"
                        f"⏸  Skipping {direction.upper()} {symbol}\n"
                        f"📅  Event: <b>{near_event}</b>\n"
                        f"🕐  ±{_NEWS_BUFFER_MINUTES}min blackout window"
                    )
                except Exception:
                    pass
            return

        # ── 1. confidence threshold (global + per-symbol) ────────
        sym_min = _SYM_MIN_CONFIDENCE.get(symbol, self._min_confidence)
        effective_min = max(self._min_confidence, sym_min)
        if confidence < effective_min:
            reasons.append(
                f"confidence {confidence}% < threshold {effective_min}% "
                f"({'symbol-specific' if sym_min > self._min_confidence else 'global'})"
            )

        # ── 2. ATR / spread ratio ─────────────────────────────────
        atr_spread_ratio = atr / max(spread, 0.0001)
        if atr_spread_ratio < self._min_atr_spread:
            reasons.append(
                f"ATR/spread {atr_spread_ratio:.1f}x < min {self._min_atr_spread:.1f}x"
            )

        # ── 3. time-of-day filter ─────────────────────────────────
        hour_utc = datetime.now(timezone.utc).hour
        in_window = (
            self._hour_start <= self._hour_end
            and self._hour_start <= hour_utc < self._hour_end
        ) or (
            self._hour_start > self._hour_end   # overnight window e.g. 22–06
            and (hour_utc >= self._hour_start or hour_utc < self._hour_end)
        )
        if not in_window:
            reasons.append(
                f"outside trading hours ({hour_utc:02d}:xx UTC, "
                f"window={self._hour_start:02d}:00–{self._hour_end:02d}:00)"
            )

        # ── 4. same-symbol position check (critical for live trading) ───
        if not reasons and symbol in self._open:
            existing_dir = self._open[symbol]
            if existing_dir == direction:
                reasons.append(
                    f"position already open: {symbol} {direction} — no stacking allowed"
                )
            # Opposite direction = allowed (hedging/reversal)

        # ── 5. correlation filter — reduce lot by 50% instead of blocking ─
        lot_scale = 1.0
        group = _corr_group(symbol)
        if group:
            same_dir = [
                sym for sym, dir_ in self._open.items()
                if sym in group and dir_ == direction and sym != symbol
            ]
            if len(same_dir) >= _CORR_MAX:
                lot_scale = 0.5
                log.info(
                    "CORR_REDUCE %s %s — correlated %s open → lot ×0.5",
                    direction.upper(), symbol, same_dir,
                )

        # ── publish ───────────────────────────────────────────────
        if reasons:
            # Time-only rejections are expected off-hours — don't count toward CB
            time_only = all("trading hours" in r for r in reasons)
            if time_only:
                log.info(
                    "SIGNAL_SKIPPED (off-hours) %s %s — not counting toward CB",
                    direction.upper(), symbol,
                )
                return
            log.info(
                "SIGNAL_REJECTED %s %s — %s",
                direction.upper(), symbol, " | ".join(reasons),
            )
            await self._bus.publish("SIGNAL_REJECTED", {
                **data,
                "rejected_reasons": reasons,
            })
        else:
            log.debug(
                "SIGNAL_APPROVED %s %s conf=%d atr/spread=%.1fx hour=%02d lot_scale=%.2f",
                direction.upper(), symbol, confidence, atr_spread_ratio, hour_utc, lot_scale,
            )
            await self._bus.publish("SIGNAL_APPROVED", {**data, "lot_scale": lot_scale})
