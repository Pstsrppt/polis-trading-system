"""
polis_mt5_bridge.py — POLIS ↔ MT5 Execution Bridge v2
=======================================================
Improvements v2:
  - Duplicate position check (no stacking same symbol+direction)
  - Close opposite hedge position before opening new one
  - Trailing stop: BE at 1R → trail price by 1×stop_dist

Flow:
  POLIS approves → Redis TRADE_APPROVED → bridge execute via MT5
  MT5 SL/TP hit → bridge detect → Redis TRADE_CLOSED → POLIS DB
"""

import json
import os
import sys
import time
import logging
import pathlib
from datetime import datetime, timezone, timedelta

# Thai log lines crash on Windows when stdout falls back to cp1252
# (console with a legacy codepage, or output redirected to a file).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

try:
    import MetaTrader5 as mt5
except ImportError:
    raise SystemExit("pip install MetaTrader5")

try:
    import redis
except ImportError:
    raise SystemExit("pip install redis")

import dotenv  # noqa: E402
_env_path = pathlib.Path(__file__).parent.parent / ".env"
if _env_path.exists():
    dotenv.load_dotenv(_env_path)

# ════════════════════════════════════════════════════════
# CONFIG
# ════════════════════════════════════════════════════════
MT5_LOGIN    = int(os.getenv("MT5_LOGIN", "0"))
MT5_PASSWORD = os.getenv("MT5_PASSWORD", "")
MT5_SERVER   = os.getenv("MT5_SERVER", "MetaQuotes-Demo")

REDIS_HOST   = "localhost"
REDIS_PORT   = 6380
MAGIC        = 20250099

SYMBOL_MAP   = {"XAUUSD": "XAUUSD", "EURUSD": "EURUSD", "GBPUSD": "GBPUSD", "XAGUSD": "XAGUSD"}

POLL_SEC         = 3      # ตรวจ positions ทุก N วินาที
MT5_PUBLISH_SEC  = 5      # publish MT5 account data ไป Redis ทุก N วินาที
MT5_ACCOUNT_KEY  = "polis:mt5_live"   # Redis key

_REWARD_RATIO    = float(os.getenv("REWARD_RATIO", "3.0"))  # TP = stop × this
PARTIAL_TP_R     = 1.0    # ปิด 50% ที่ 1R profit
PARTIAL_TP_PCT   = 0.5    # ปิดกี่ % (0.5 = ครึ่งหนึ่ง)
TRAIL_ACTIVATE_R = float(os.getenv("TRAIL_ACTIVATE_R", "1.0"))  # BE at 1R
TRAIL_STEP_R     = 0.5    # trail ทุก 0.5R
# ════════════════════════════════════════════════════════

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [BRIDGE] %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("bridge")


# ── MT5 Connection ────────────────────────────────────────────────────

def mt5_connect() -> bool:
    if mt5.initialize():
        acc = mt5.account_info()
        if acc:
            log.info("MT5 connected — %s | Balance: $%.2f", acc.login, acc.balance)
            return True
    if MT5_LOGIN and MT5_PASSWORD:
        if mt5.initialize(login=MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER):
            acc = mt5.account_info()
            log.info("MT5 connected (login) — %s | Balance: $%.2f", acc.login, acc.balance)
            return True
    log.error("MT5 connect failed: %s", mt5.last_error())
    return False


# ── Position Helpers ──────────────────────────────────────────────────

def get_bridge_positions(symbol: str | None = None) -> list:
    """คืน open positions ทั้งหมด (รวม manual)"""
    pos = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
    if not pos:
        return []
    return list(pos)


def close_position(pos) -> bool:
    """ปิด position ด้วย market order — ลอง RETURN → IOC → FOK"""
    tick = mt5.symbol_info_tick(pos.symbol)
    if not tick:
        log.warning("close_position: no tick for %s", pos.symbol)
        return False
    is_buy = pos.type == mt5.ORDER_TYPE_BUY
    base_req = {
        "action":    mt5.TRADE_ACTION_DEAL,
        "symbol":    pos.symbol,
        "volume":    pos.volume,
        "type":      mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY,
        "position":  pos.ticket,
        "price":     tick.bid if is_buy else tick.ask,
        "deviation": 30,
        "magic":     MAGIC,
        "comment":   "polis_close",
        "type_time": mt5.ORDER_TIME_GTC,
    }
    for filling in (mt5.ORDER_FILLING_RETURN, mt5.ORDER_FILLING_IOC, mt5.ORDER_FILLING_FOK):
        req = {**base_req, "type_filling": filling}
        res = mt5.order_send(req)
        if res:
            log.info("close_position: filling=%d retcode=%d comment=%s", filling, res.retcode, res.comment)
            if res.retcode == mt5.TRADE_RETCODE_DONE:
                return True
        else:
            log.warning("close_position: order_send returned None (filling=%d) err=%s", filling, mt5.last_error())
    return False


def filling_mode_for(symbol: str) -> int:
    """Pick a filling mode the symbol actually accepts.

    MT5 rejects the order with retcode 10030 otherwise. On this broker XAUUSD
    and XAGUSD allow FOK+IOC, while EURUSD and GBPUSD allow FOK only — a
    hardcoded IOC silently made every forex order fail.
    """
    info = mt5.symbol_info(symbol)
    mask = info.filling_mode if info else 0
    if mask & 2:    # SYMBOL_FILLING_IOC
        return mt5.ORDER_FILLING_IOC
    if mask & 1:    # SYMBOL_FILLING_FOK
        return mt5.ORDER_FILLING_FOK
    return mt5.ORDER_FILLING_RETURN


def modify_sl(ticket: int, new_sl: float, new_tp: float) -> bool:
    """Move the stop on an open position.

    TRADE_ACTION_SLTP identifies an open position with "position" and needs the
    symbol; "ticket" addresses a *pending order* and returns 10013 Invalid
    request. Every trailing-stop move had been failing that way, silently,
    because the result was never logged — so winners that ran past 1R kept their
    original stop and could give the whole gain back.
    """
    positions = mt5.positions_get(ticket=ticket)
    if not positions:
        log.warning("modify_sl: position %d not found", ticket)
        return False

    req = {
        "action":   mt5.TRADE_ACTION_SLTP,
        "symbol":   positions[0].symbol,
        "position": ticket,
        "sl":       round(new_sl, 5),
        "tp":       round(new_tp, 5),
    }
    res = mt5.order_send(req)
    if res and res.retcode == mt5.TRADE_RETCODE_DONE:
        return True
    log.warning("modify_sl failed ticket=%d retcode=%s %s", ticket,
                res.retcode if res else "None",
                getattr(res, "comment", "") or mt5.last_error())
    return False


# ── Duplicate Check + Execute ─────────────────────────────────────────

_pub: "redis.Redis | None" = None


def _publish(topic: str, payload: dict) -> None:
    """Best-effort event back to POLIS — telemetry must never break execution."""
    global _pub
    try:
        if _pub is None:
            _pub = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
        _pub.publish(topic, json.dumps(payload))
    except Exception as exc:
        log.debug("publish %s failed: %s", topic, exc)


def order_result(ok: bool, data: dict, reason: str, ticket: int = 0,
                 fill_price: float = 0.0) -> None:
    """Report every order outcome, success or not.

    Without this the gateway records an approved trade the moment it publishes
    TRADE_APPROVED, so a rejection here (market closed, duplicate, hedge that
    would not close) left the database claiming a position that MT5 never
    opened — and the dashboard showed nothing at all.
    """
    _publish("MT5_ORDER_RESULT", {
        "ok":        ok,
        "symbol":    data.get("symbol"),
        "direction": data.get("direction"),
        "lots":      data.get("lots"),
        "source":    data.get("source", "kernel"),
        "db_id":     data.get("db_id"),
        "ticket":    ticket,
        "fill_price": fill_price,
        "reason":    reason,
    })


def execute_order(data: dict, open_tickets: dict) -> dict | None:
    """
    ก่อน execute ตรวจ:
    1. มี position เดิมในทิศเดียวกันไหม → skip
    2. มี position ตรงข้ามไหม → ปิดก่อนแล้วเปิดใหม่
    """
    direction  = str(data.get("direction", "")).lower()
    symbol_raw = str(data.get("symbol", "XAUUSD")).upper().replace("/", "")
    symbol     = SYMBOL_MAP.get(symbol_raw, symbol_raw)
    lots       = float(data.get("lots", 0.01))
    stop_dist  = float(data.get("stop", 0))
    db_id      = data.get("db_id")

    # ── ตรวจ positions ที่มีอยู่แล้ว ─────────────────────────────
    # A trader pressing the button is making a deliberate choice to add to a
    # position; the automatic path still may not stack, so a repeating signal
    # cannot pile on by itself.
    allow_stacking = str(data.get("source", "")) == "manual"

    existing = get_bridge_positions(symbol)
    for pos in existing:
        is_long = pos.type == mt5.ORDER_TYPE_BUY

        if (direction == "long" and is_long) or (direction == "short" and not is_long):
            if allow_stacking:
                log.info("➕  STACKING — manual %s %s alongside ticket=%d",
                         direction.upper(), symbol, pos.ticket)
                continue
            log.warning("⏭  SKIP — %s %s already open (ticket=%d)",
                        direction.upper(), symbol, pos.ticket)
            order_result(False, data,
                         f"มีไม้ {direction.upper()} {symbol} เปิดอยู่แล้ว (#{pos.ticket})")
            return None

        if (direction == "long" and not is_long) or (direction == "short" and is_long):
            log.info("🔄  Closing opposite position ticket=%d before opening %s",
                     pos.ticket, direction.upper())
            if close_position(pos):
                log.info("    ✅ Closed opposite position")
                # ลบออกจาก open_tickets ด้วย
                open_tickets.pop(pos.ticket, None)
            else:
                log.warning("    ❌ Could not close opposite — skipping new order")
                order_result(False, data,
                             f"ปิดไม้ตรงข้าม #{pos.ticket} ไม่สำเร็จ — ไม่เปิดไม้ใหม่")
                return None

    # ── Place order ───────────────────────────────────────────────
    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        # Symbol not in Market Watch yet — subscribe and retry once.
        mt5.symbol_select(symbol, True)
        tick = mt5.symbol_info_tick(symbol)
    if not tick:
        log.error("No tick for %s", symbol)
        order_result(False, data, f"ไม่มีราคาของ {symbol} — ตลาดน่าจะปิดอยู่")
        return None

    if direction == "long":
        price      = tick.ask
        order_type = mt5.ORDER_TYPE_BUY
        sl         = round(price - stop_dist, 5) if stop_dist else 0
        tp         = round(price + stop_dist * _REWARD_RATIO, 5) if stop_dist else 0
    else:
        price      = tick.bid
        order_type = mt5.ORDER_TYPE_SELL
        sl         = round(price + stop_dist, 5) if stop_dist else 0
        tp         = round(price - stop_dist * _REWARD_RATIO, 5) if stop_dist else 0

    req = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "symbol":       symbol,
        "volume":       max(0.01, round(lots, 2)),
        "type":         order_type,
        "price":        price,
        "sl":           sl,
        "tp":           tp,
        "deviation":    20,
        "magic":        MAGIC,
        "comment":      f"polis#{db_id}",
        "type_time":    mt5.ORDER_TIME_GTC,
        "type_filling": filling_mode_for(symbol),
    }

    res = mt5.order_send(req)
    if res and res.retcode == mt5.TRADE_RETCODE_DONE:
        # res.price comes back 0.0 on some brokers/filling modes. Every R
        # calculation downstream divides by it, so read the real fill from the
        # position itself — a zero entry fires partial TP instantly at a fake
        # +200R and drives the short-side trailing stop to 0.
        entry_price = res.price
        if not entry_price:
            opened = mt5.positions_get(ticket=res.order)
            if opened:
                entry_price = opened[0].price_open
        if not entry_price:
            entry_price = price
            log.warning("    ⚠ no fill price from MT5 — using requested %.5f", price)

        log.info("✅ ORDER PLACED  %s %s  %.2f lots @ %.5f  SL=%.5f  TP=%.5f  ticket=%d",
                 direction.upper(), symbol, lots, entry_price, sl, tp, res.order)
        order_result(True, data, f"เปิดไม้ที่ {entry_price:.5f}",
                     ticket=res.order, fill_price=entry_price)
        return {
            "ticket":    res.order,
            "db_id":     db_id,
            "symbol":    symbol,
            "direction": direction,
            "entry":     entry_price,
            "sl":        sl,
            "tp":        tp,
            "orig_sl_d": stop_dist,
            "lots":      lots,
            "be_done":   False,
        }
    else:
        log.error("❌ ORDER FAILED  retcode=%s  %s",
                  res.retcode if res else "None", mt5.last_error())
        comment = getattr(res, "comment", "") if res else ""
        code    = res.retcode if res else "no response"
        order_result(False, data, f"MT5 ปฏิเสธ ({code}) {comment}".strip())
        return None


# ── Trailing Stop ─────────────────────────────────────────────────────

def partial_close(pos, pct: float) -> float:
    """ปิด pct% ของ position — คืน lots ที่ปิดจริง"""
    close_lots = round(pos.volume * pct, 2)
    if close_lots < 0.01:
        return 0.0
    tick = mt5.symbol_info_tick(pos.symbol)
    if not tick:
        return 0.0
    is_buy = pos.type == mt5.ORDER_TYPE_BUY
    req = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "symbol":       pos.symbol,
        "volume":       close_lots,
        "type":         mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY,
        "position":     pos.ticket,
        "price":        tick.bid if is_buy else tick.ask,
        "deviation":    20,
        "magic":        MAGIC,
        "comment":      "polis_partial",
        "type_time":    mt5.ORDER_TIME_GTC,
        "type_filling": filling_mode_for(pos.symbol),
    }
    res = mt5.order_send(req)
    if res and res.retcode == mt5.TRADE_RETCODE_DONE:
        return close_lots
    return 0.0


def rehydrate_open_tickets(open_tickets: dict) -> int:
    """Rebuild in-memory position state from MT5 after a restart.

    Trailing and partial TP are both driven by open_tickets, so a restart left
    every already-open position unmanaged: a trade sitting at +1.7R kept its
    original stop below entry and could hand the entire gain back. The
    supervisor restarts this process on any crash, which made that the normal
    case rather than a rare one.
    """
    recovered = 0
    for pos in mt5.positions_get() or []:
        if pos.magic != MAGIC or pos.ticket in open_tickets:
            continue
        is_long = pos.type == mt5.ORDER_TYPE_BUY

        # TP is written once at entry and never moved, so it recovers the
        # original stop distance even after the stop itself has been trailed.
        if pos.tp:
            stop_dist = abs(pos.tp - pos.price_open) / _REWARD_RATIO
        else:
            stop_dist = abs(pos.price_open - pos.sl) if pos.sl else 0.0

        price = pos.price_current or pos.price_open
        gain  = (price - pos.price_open) if is_long else (pos.price_open - price)
        r     = gain / stop_dist if stop_dist else 0.0

        db_id = None
        tag = str(getattr(pos, "comment", "") or "")
        if tag.startswith("polis#") and tag[6:].isdigit():
            db_id = int(tag[6:])

        open_tickets[pos.ticket] = {
            "ticket":    pos.ticket,
            "db_id":     db_id,
            "symbol":    pos.symbol,
            "direction": "long" if is_long else "short",
            "entry":     pos.price_open,
            "sl":        pos.sl,
            "tp":        pos.tp,
            "orig_sl_d": stop_dist,
            "lots":      pos.volume,
            # Stop already at or past entry means breakeven was taken.
            "be_done":   bool(pos.sl) and (pos.sl >= pos.price_open if is_long
                                           else pos.sl <= pos.price_open),
            # Past the partial level already: assume it was taken rather than
            # risk shaving the position a second time.
            "partial_done": r >= PARTIAL_TP_R,
        }
        recovered += 1
        log.info("♻  RECOVERED  %s %s ticket=%d  entry=%.5f  %.2fR  stop_d=%.5f",
                 open_tickets[pos.ticket]["direction"].upper(), pos.symbol,
                 pos.ticket, pos.price_open, r, stop_dist)
    return recovered


def manage_trailing(open_tickets: dict) -> None:
    """
    Trailing Stop — ตรงกับ POLIS trade_tracker logic:
      Phase 1 (< TRAIL_ACTIVATE_R):   SL คงที่
      Phase 2 (≥ TRAIL_ACTIVATE_R):   SL → breakeven (entry)
      Phase 3 (> TRAIL_ACTIVATE_R):   SL trails price by orig_sl_d
    """
    if not open_tickets:
        return

    tick_cache: dict[str, object] = {}

    for ticket, meta in list(open_tickets.items()):
        pos = None
        positions = mt5.positions_get(ticket=ticket)
        if positions:
            pos = positions[0]
        if not pos:
            continue

        symbol    = meta["symbol"]
        entry     = meta["entry"]
        orig_sl_d = meta.get("orig_sl_d", 0)
        direction = meta["direction"]
        be_done   = meta.get("be_done", False)

        if orig_sl_d <= 0:
            continue

        # ดึง current price
        if symbol not in tick_cache:
            tick_cache[symbol] = mt5.symbol_info_tick(symbol)
        tick = tick_cache[symbol]
        if not tick:
            continue

        price = tick.bid if direction == "long" else tick.ask

        # คำนวณ R gained
        if direction == "long":
            r = (price - entry) / orig_sl_d
        else:
            r = (entry - price) / orig_sl_d

        # ── Partial TP: ปิด 50% เมื่อ profit ≥ PARTIAL_TP_R ────────
        if r >= PARTIAL_TP_R and not meta.get("partial_done"):
            closed_lots = partial_close(pos, PARTIAL_TP_PCT)
            if closed_lots > 0:
                meta["partial_done"] = True
                log.info(
                    "📊 PARTIAL TP  %s %s ticket=%d  closed %.2f lots at +%.1fR  remaining %.2f lots",
                    direction.upper(), symbol, ticket, closed_lots, r,
                    pos.volume - closed_lots,
                )

        if r < TRAIL_ACTIVATE_R:
            continue  # ยังไม่ถึง 1R — ไม่ trail

        # คำนวณ new SL
        if direction == "long":
            # trail: SL = max(entry, price - orig_sl_d)
            trail_sl = round(max(entry, price - orig_sl_d), 5)
            if trail_sl > pos.sl + 0.001:
                if modify_sl(ticket, trail_sl, pos.tp):
                    tag = "BE" if not be_done else f"+{r:.1f}R"
                    log.info("🎯 TRAIL [%s] LONG %s ticket=%d  SL %.5f→%.5f  (%.1fR)",
                             tag, symbol, ticket, pos.sl, trail_sl, r)
                    meta["be_done"] = True
                    meta["sl"]      = trail_sl
        else:
            trail_sl = round(min(entry, price + orig_sl_d), 5)
            if trail_sl < pos.sl - 0.001:
                if modify_sl(ticket, trail_sl, pos.tp):
                    tag = "BE" if not be_done else f"+{r:.1f}R"
                    log.info("🎯 TRAIL [%s] SELL %s ticket=%d  SL %.5f→%.5f  (%.1fR)",
                             tag, symbol, ticket, pos.sl, trail_sl, r)
                    meta["be_done"] = True
                    meta["sl"]      = trail_sl


# ── Check Closed ──────────────────────────────────────────────────────

_REPORTED_KEY  = "polis:mt5_reported_closes"
_BRIDGE_START  = datetime.now(timezone.utc)


def check_closed_positions(open_tickets: dict, r: "redis.Redis") -> None:
    """Report positions MT5 has closed, driven by deal history rather than memory.

    The old version only looked at `open_tickets`, so a position opened before a
    bridge restart could never be reported — and a whole night of SL hits went
    unrecorded, leaving the database showing trades as still open. Deal history
    survives restarts; a Redis set keeps us from reporting the same close twice.
    """
    now   = datetime.now(timezone.utc)
    deals = mt5.history_deals_get(_BRIDGE_START - timedelta(minutes=5), now + timedelta(hours=1))
    if not deals:
        return

    outs: dict[int, list] = {}
    ins:  dict[int, object] = {}
    for deal in deals:
        if deal.magic != MAGIC:
            continue
        if deal.entry == mt5.DEAL_ENTRY_OUT:
            outs.setdefault(deal.position_id, []).append(deal)
        elif deal.entry == mt5.DEAL_ENTRY_IN:
            ins[deal.position_id] = deal

    for pid, position_deals in outs.items():
        # A partial take-profit also produces an OUT deal — only report the
        # position once MT5 says nothing is left of it.
        if mt5.positions_get(ticket=pid):
            continue
        try:
            if r.sismember(_REPORTED_KEY, str(pid)):
                continue
        except Exception as exc:
            log.debug("reported-set read failed: %s", exc)

        meta    = open_tickets.get(pid, {})
        opening = ins.get(pid)
        last    = max(position_deals, key=lambda d: d.time)
        pnl     = round(sum(d.profit + d.commission + d.swap for d in position_deals), 2)
        result  = "WIN" if pnl > 0 else "LOSS"

        db_id = meta.get("db_id")
        if db_id is None and opening:
            # Recover the decision id the order was tagged with (polis#1234)
            tag = str(getattr(opening, "comment", ""))
            if tag.startswith("polis#") and tag[6:].isdigit():
                db_id = int(tag[6:])

        direction = meta.get("direction")
        if not direction and opening is not None:
            direction = "long" if opening.type == mt5.DEAL_TYPE_BUY else "short"

        payload = {
            "id":         db_id,
            "symbol":     meta.get("symbol") or last.symbol,
            "direction":  direction or "",
            "entry":      meta.get("entry") or (round(opening.price, 5) if opening else 0),
            "exit_price": round(last.price, 5),
            "pnl_usd":    pnl,
            "result":     result,
            "lots":       meta.get("lots") or round(sum(d.volume for d in position_deals), 2),
            "source":     "mt5_bridge",
        }
        r.publish("TRADE_CLOSED", json.dumps(payload))
        log.info("📤 TRADE_CLOSED  #%s  %s  P&L=$%.2f  [%s]%s",
                 db_id, payload["symbol"], pnl, result,
                 "  🎯 trailed" if meta.get("be_done") else "")

        try:
            r.sadd(_REPORTED_KEY, str(pid))
            r.expire(_REPORTED_KEY, 7 * 24 * 3600)
        except Exception as exc:
            log.debug("reported-set write failed: %s", exc)
        open_tickets.pop(pid, None)


# ── Main ──────────────────────────────────────────────────────────────

def main():
    if not mt5_connect():
        return

    r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
    try:
        r.ping()
        log.info("Redis connected — %s:%d", REDIS_HOST, REDIS_PORT)
    except Exception as e:
        log.error("Redis connect failed: %s", e)
        return

    pubsub = r.pubsub()
    pubsub.subscribe("TRADE_APPROVED", "MT5_CLOSE_REQUEST")

    open_tickets: dict   = {}
    last_check   = time.time()
    last_publish = time.time()
    last_price   = time.time()
    PRICE_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "XAGUSD"]
    PRICE_PUBLISH_SEC = 1

    print("\n" + "="*60)
    print("  POLIS MT5 Bridge v2 รันอยู่")
    print(f"  Redis:    {REDIS_HOST}:{REDIS_PORT}")
    print(f"  MT5:      {MT5_LOGIN} @ {MT5_SERVER}")
    print(f"  Trailing: BE at {TRAIL_ACTIVATE_R}R, trail by 1×stop")
    print(f"  Duplicate check: ON  |  Anti-hedge: ON")
    print("  กด Ctrl+C เพื่อหยุด")
    print("="*60 + "\n")
    log.info("Subscribed to TRADE_APPROVED — ready ✅")

    try:
        while True:
            # ── รับ messages ──────────────────────────────────────
            msg = pubsub.get_message(timeout=0.1)
            if msg and msg["type"] == "message":
                try:
                    data    = json.loads(msg["data"])
                    channel = msg.get("channel", "")

                    if channel == "TRADE_APPROVED":
                        log.info("📥 TRADE_APPROVED  #%s  %s %s  conf=%s%%",
                                 data.get("db_id"),
                                 data.get("direction", "?").upper(),
                                 data.get("symbol", "?"),
                                 data.get("confidence", "?"))
                        meta = execute_order(data, open_tickets)
                        if meta:
                            open_tickets[meta["ticket"]] = meta

                    elif channel == "MT5_CLOSE_REQUEST":
                        ticket = int(data.get("ticket", 0))
                        log.info("📥 MT5_CLOSE_REQUEST  ticket=%d", ticket)
                        positions = mt5.positions_get(ticket=ticket)
                        if positions:
                            ok = close_position(positions[0])
                            log.info("  %s manual close ticket=%d",
                                     "✅" if ok else "❌", ticket)
                            if ok:
                                open_tickets.pop(ticket, None)
                        else:
                            log.warning("  ⚠️ ticket=%d not found", ticket)

                except Exception as exc:
                    log.error("process message error: %s", exc)

            # ── ตรวจ / Trail ทุก POLL_SEC ─────────────────────────
            now = time.time()
            if now - last_check >= POLL_SEC:
                last_check = now
                try:
                    rehydrate_open_tickets(open_tickets)
                    manage_trailing(open_tickets)
                    check_closed_positions(open_tickets, r)
                except Exception as exc:
                    log.error("poll error: %s", exc)

                if not mt5.terminal_info():
                    log.warning("MT5 disconnected — reconnecting...")
                    mt5_connect()

            # ── Publish MT5 account data → Redis ──────────────────
            if now - last_publish >= MT5_PUBLISH_SEC:
                last_publish = now
                try:
                    acc = mt5.account_info()
                    if acc:
                        positions = get_bridge_positions()
                        open_pnl  = sum(p.profit for p in mt5.positions_get() or [])
                        payload   = {
                            "login":       acc.login,
                            "balance":     round(acc.balance, 2),
                            "equity":      round(acc.equity, 2),
                            "margin":      round(acc.margin, 2),
                            "free_margin": round(acc.margin_free, 2),
                            "open_pnl":    round(open_pnl, 2),
                            "open_pos":    len(positions),
                            "server":      MT5_SERVER,
                            "ts":          datetime.now(timezone.utc).isoformat(),
                        }
                        r.set(MT5_ACCOUNT_KEY, json.dumps(payload), ex=30)

                        # publish individual positions
                        pos_list = [{
                            "ticket":    p.ticket,
                            "symbol":    p.symbol,
                            "direction": "long" if p.type == mt5.ORDER_TYPE_BUY else "short",
                            "lots":      round(p.volume, 2),
                            "entry":     round(p.price_open, 5),
                            "current":   round(p.price_current, 5),
                            "sl":        round(p.sl, 5),
                            "tp":        round(p.tp, 5),
                            "pnl":       round(p.profit, 2),
                            "swap":      round(p.swap, 2),
                            "open_time": p.time,
                        } for p in positions]
                        r.set("polis:mt5_positions", json.dumps(pos_list), ex=30)
                except Exception as exc:
                    log.debug("MT5 publish error: %s", exc)

            # ── Publish live prices → Redis ────────────────────────
            if now - last_price >= PRICE_PUBLISH_SEC:
                last_price = now
                try:
                    prices = {}
                    for sym in PRICE_SYMBOLS:
                        tick = mt5.symbol_info_tick(sym)
                        if tick:
                            prices[sym] = {
                                "bid": round(tick.bid, 5),
                                "ask": round(tick.ask, 5),
                                "mid": round((tick.bid + tick.ask) / 2, 5),
                                "ts":  tick.time,
                            }
                    if prices:
                        r.set("polis:mt5_prices", json.dumps(prices), ex=10)
                except Exception as exc:
                    log.debug("Price publish error: %s", exc)

    except KeyboardInterrupt:
        log.info("Bridge หยุดแล้ว")
    finally:
        mt5.shutdown()
        pubsub.close()


if __name__ == "__main__":
    main()
