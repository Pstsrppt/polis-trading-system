"""Trade Tracker — monitors open trades and closes them when TP/SL is hit.

Trailing Stop logic (3 phases):
  Phase 1 — Normal:     SL = entry ∓ stop_dist
  Phase 2 — Breakeven:  after 1R gain → SL moves to entry (0 loss guaranteed)
  Phase 3 — Trailing:   after 2R gain → SL trails price by 1 stop_dist (lets winners run)

Hard TP still applies at _REWARD_RATIO × stop (caps upside, ensures signal is recorded).
P&L formula: (exit - entry) × lots × units_per_lot  (symbol-aware)
"""
import logging
import os

log = logging.getLogger("kernel.tracker")

_REWARD_RATIO    = float(os.getenv("REWARD_RATIO",    "3.0"))
_TRAIL_ACTIVATE_R = float(os.getenv("TRAIL_ACTIVATE_R", "1.0"))  # move to BE after 1R

_UNITS_PER_LOT: dict[str, int] = {
    "XAUUSD": 100,
    "EURUSD": 100_000,
    "GBPUSD": 100_000,
    "BTCUSD": 1,
    "XAGUSD": 5_000,
}


def _r_gained(t: dict, price: float) -> float:
    """How many R's of gain the trade has captured so far."""
    entry = t["price"]; stop = t["stop"]
    if stop <= 0:
        return 0.0
    if t["direction"].lower() == "long":
        return (price - entry) / stop
    return (entry - price) / stop


class TradeTracker:
    def __init__(self, bus, db_module, discord_notifier=None, telegram_bot=None) -> None:
        self._bus     = bus
        self._db      = db_module
        self._discord = discord_notifier
        self._tg      = telegram_bot
        self._open: dict[int, dict] = {}

        bus.subscribe("TRADE_APPROVED", self._on_approved)
        bus.subscribe("TRADE_SIGNAL",   self._on_tick)
        bus.subscribe("TRADE_CLOSED",   self._on_closed_external)
        log.info(
            "TradeTracker ready — TP=%.1fR  trail_BE_at=%.1fR",
            _REWARD_RATIO, _TRAIL_ACTIVATE_R,
        )

    async def init(self) -> None:
        rows = await self._db.get_open_trades()
        for r in rows:
            d = dict(r)
            d.setdefault("trail_sl", None)
            d.setdefault("breakeven_done", False)
            self._open[d["id"]] = d
        log.info("TradeTracker: loaded %d open trade(s) from DB", len(self._open))

    # ── event handlers ────────────────────────────────────────────
    async def _on_approved(self, data: dict) -> None:
        trade_id = data.get("db_id")
        if not trade_id:
            return
        symbol    = data.get("symbol", "XAUUSD")
        direction = data.get("direction", "long").upper()
        price     = float(data.get("price", 0))
        lots      = float(data.get("lots", 0))
        stop      = float(data.get("stop", 0))
        conf      = data.get("confidence", "?")
        risk_usd  = float(data.get("risk_usd", 0))
        self._open[trade_id] = {
            "id":            trade_id,
            "symbol":        symbol,
            "direction":     data.get("direction", "long"),
            "price":         price,
            "stop":          stop,
            "lots":          lots,
            "trail_sl":      None,
            "breakeven_done": False,
        }
        log.debug("TradeTracker: tracking trade #%d", trade_id)
        if self._tg:
            dir_icon = "📈" if direction == "LONG" else "📉"
            try:
                await self._tg.notify(
                    f"{dir_icon}  <b>เปิดเทรดแล้ว — {direction} {symbol}</b>\n\n"
                    f"💰  Price: <b>{price:.5g}</b>\n"
                    f"📦  Lots: <b>{lots:.2f}</b>\n"
                    f"🛡  Stop: <b>{stop:.5g} pts</b>\n"
                    f"⚠️  Risk: <b>${risk_usd:,.2f}</b>\n"
                    f"🤖  Confidence: <b>{conf}%</b>\n\n"
                    f"Trade #{trade_id}"
                )
            except Exception as exc:
                log.warning("Tracker tg open notify failed: %s", exc)

    async def _on_tick(self, data: dict) -> None:
        if not self._open:
            return
        symbol    = data.get("symbol", "XAUUSD")
        cur_price = float(data.get("price", 0))
        if cur_price <= 0:
            return

        to_close = []
        for trade_id, t in self._open.items():
            if t["symbol"] != symbol:
                continue
            self._update_trail(t, cur_price)
            result = self._check(t, cur_price)
            if result:
                to_close.append((trade_id, t, cur_price, result))

        for trade_id, t, exit_price, result in to_close:
            await self._close(trade_id, t, exit_price, result)

    async def _on_closed_external(self, data: dict) -> None:
        trade_id = data.get("id")
        if trade_id and trade_id in self._open:
            del self._open[trade_id]
            log.info("TradeTracker: removed #%d (manual close)", trade_id)

    # ── trailing stop engine ──────────────────────────────────────
    def _update_trail(self, t: dict, price: float) -> None:
        """Advance the trailing stop based on current price."""
        entry = t["price"]; stop = t["stop"]; direction = t["direction"].lower()
        if stop <= 0:
            return

        r = _r_gained(t, price)

        # Phase 2: move stop to breakeven after TRAIL_ACTIVATE_R gain
        if r >= _TRAIL_ACTIVATE_R and not t["breakeven_done"]:
            t["breakeven_done"] = True
            t["trail_sl"]       = entry
            log.info(
                "TRAIL #%d %s %s — breakeven activated (%.1fR gain)",
                t["id"], direction.upper(), t["symbol"], r,
            )

        # Phase 3: trail behind price (always 1 stop_dist away)
        if t["trail_sl"] is not None:
            if direction == "long":
                new_sl = price - stop
                if new_sl > t["trail_sl"]:
                    t["trail_sl"] = new_sl
            else:
                new_sl = price + stop
                if new_sl < t["trail_sl"]:
                    t["trail_sl"] = new_sl

    def _check(self, t: dict, price: float) -> str | None:
        entry = t["price"]; stop = t["stop"]; direction = t["direction"].lower()
        if stop <= 0 or entry <= 0:
            return None

        # Hard TP (always active — caps upside, gives clean WIN signal)
        tp_dist = stop * _REWARD_RATIO
        if direction == "long" and price >= entry + tp_dist:
            return "WIN"
        if direction == "short" and price <= entry - tp_dist:
            return "WIN"

        # Trailing / breakeven SL
        trail_sl = t.get("trail_sl")
        if trail_sl is not None:
            if direction == "long"  and price <= trail_sl:
                return "WIN"   # trail_sl >= entry, so always a win or breakeven
            if direction == "short" and price >= trail_sl:
                return "WIN"
        else:
            # Normal SL
            if direction == "long"  and price <= entry - stop:
                return "LOSS"
            if direction == "short" and price >= entry + stop:
                return "LOSS"

        return None

    # ── close trade ───────────────────────────────────────────────
    async def _close(self, trade_id: int, t: dict, exit_price: float, result: str) -> None:
        direction = t["direction"].lower()
        entry = t["price"]; lots = t["lots"]
        units = _UNITS_PER_LOT.get(t.get("symbol", "XAUUSD"), 100)

        if direction == "long":
            pnl = (exit_price - entry) * lots * units
        else:
            pnl = (entry - exit_price) * lots * units
        pnl = round(pnl, 2)

        # If trailing stop closed at breakeven, override result based on actual P&L
        if pnl < 0:
            result = "LOSS"

        await self._db.close_trade(trade_id, exit_price, pnl, result)
        del self._open[trade_id]

        trail_tag = " [trailing]" if t.get("breakeven_done") else ""
        icon = "✅" if result == "WIN" else ("⚖️" if abs(pnl) < 0.01 else "❌")
        log.info(
            "TRADE_CLOSED #%d %s %s  entry=%.5g exit=%.5g  P&L=$%.2f  [%s]%s",
            trade_id, direction.upper(), t["symbol"],
            entry, exit_price, pnl, result, trail_tag,
        )

        await self._bus.publish("TRADE_CLOSED", {
            "id":         trade_id,
            "symbol":     t["symbol"],
            "direction":  direction,
            "entry":      entry,
            "exit_price": exit_price,
            "pnl_usd":    pnl,
            "result":     result,
            "lots":       lots,
            "trailing":   t.get("breakeven_done", False),
        })
        await self._notify(t, exit_price, pnl, result, icon)

    async def _notify(self, t: dict, exit_price: float, pnl: float, result: str, icon: str) -> None:
        direction = t["direction"].upper()
        symbol    = t["symbol"]
        pnl_color = 0x10b981 if pnl >= 0 else 0xef4444
        result_th = "กำไร" if result == "WIN" else ("เสมอ" if abs(pnl) < 0.01 else "ขาดทุน")
        trail_tag = "🎯 Trailing Stop" if t.get("breakeven_done") else "🎯 Target"

        def _fp(v: float) -> str:
            return f"${v:.5g}" if v < 10 else f"${v:,.2f}" if v < 1000 else f"${v:,.0f}"

        if self._discord:
            try:
                await self._discord._post({"embeds": [{
                    "title":  f"{icon}  TRADE CLOSED — {direction} {symbol}",
                    "color":  pnl_color,
                    "fields": [
                        {"name": "Entry",  "value": _fp(t["price"]),  "inline": True},
                        {"name": "Exit",   "value": _fp(exit_price),  "inline": True},
                        {"name": "P&L",    "value": f"${pnl:+,.2f}",  "inline": True},
                        {"name": "Lots",   "value": f"{t['lots']:.2f}", "inline": True},
                        {"name": "Result", "value": result,             "inline": True},
                        {"name": "Close",  "value": trail_tag,          "inline": True},
                    ],
                    "footer": {"text": "POLIS Trade Tracker"},
                }]})
            except Exception as exc:
                log.warning("Tracker discord notify failed: %s", exc)

        if self._tg:
            try:
                pnl_str = f"${pnl:+,.2f}"
                await self._tg.notify(
                    f"{icon}  <b>ปิดเทรดแล้ว — {result_th}</b>\n\n"
                    f"📌 {direction} {symbol}\n"
                    f"🔵 เข้า: <b>{_fp(t['price'])}</b>\n"
                    f"🔴 ออก: <b>{_fp(exit_price)}</b>\n"
                    f"💰 P&L: <b>{pnl_str}</b>\n"
                    f"🎯 Close: {trail_tag}"
                )
                dir_icon = "📈" if direction == "LONG" else "📉"
                await self._tg.broadcast_signal(
                    f"{icon}  <b>POLIS SIGNAL UPDATE</b>\n"
                    f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
                    f"{dir_icon}  <b>{direction}  {symbol}</b>  →  <b>{result}</b>\n\n"
                    f"<code>"
                    f"  🔵 Entry    {_fp(t['price'])}\n"
                    f"  🔴 Exit     {_fp(exit_price)}\n"
                    f"  💰 P&L      {pnl_str}"
                    f"</code>\n\n"
                    f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
                    f"🤖  <i>POLIS AI · Automated Signal</i>"
                )
            except Exception as exc:
                log.warning("Tracker telegram notify failed: %s", exc)
