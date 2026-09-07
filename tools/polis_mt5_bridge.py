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
import math
import os
import time
import logging
import pathlib
from datetime import datetime, timezone, timedelta

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


def modify_sl(ticket: int, new_sl: float, new_tp: float) -> bool:
    req = {
        "action": mt5.TRADE_ACTION_SLTP,
        "ticket": ticket,
        "sl":     round(new_sl, 5),
        "tp":     round(new_tp, 5),
    }
    res = mt5.order_send(req)
    return bool(res and res.retcode == mt5.TRADE_RETCODE_DONE)


# ── Duplicate Check + Execute ─────────────────────────────────────────

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
    existing = get_bridge_positions(symbol)
    for pos in existing:
        is_long = pos.type == mt5.ORDER_TYPE_BUY

        if (direction == "long" and is_long) or (direction == "short" and not is_long):
            log.warning("⏭  SKIP — %s %s already open (ticket=%d)",
                        direction.upper(), symbol, pos.ticket)
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
                return None

    # ── Place order ───────────────────────────────────────────────
    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        log.error("No tick for %s", symbol)
        return None

    if direction == "long":
        price      = tick.ask
        order_type = mt5.ORDER_TYPE_BUY
        sl         = round(price - stop_dist, 5) if stop_dist else 0
        tp         = round(price + stop_dist * 3, 5) if stop_dist else 0
    else:
        price      = tick.bid
        order_type = mt5.ORDER_TYPE_SELL
        sl         = round(price + stop_dist, 5) if stop_dist else 0
        tp         = round(price - stop_dist * 3, 5) if stop_dist else 0

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
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    res = mt5.order_send(req)
    if res and res.retcode == mt5.TRADE_RETCODE_DONE:
        log.info("✅ ORDER PLACED  %s %s  %.2f lots @ %.5f  SL=%.5f  TP=%.5f  ticket=%d",
                 direction.upper(), symbol, lots, res.price, sl, tp, res.order)
        return {
            "ticket":    res.order,
            "db_id":     db_id,
            "symbol":    symbol,
            "direction": direction,
            "entry":     res.price,
            "sl":        sl,
            "tp":        tp,
            "orig_sl_d": stop_dist,
            "lots":      lots,
            "be_done":   False,
        }
    else:
        log.error("❌ ORDER FAILED  retcode=%s  %s",
                  res.retcode if res else "None", mt5.last_error())
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
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    res = mt5.order_send(req)
    if res and res.retcode == mt5.TRADE_RETCODE_DONE:
        return close_lots
    return 0.0


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

def check_closed_positions(open_tickets: dict, r: "redis.Redis") -> None:
    if not open_tickets:
        return

    since = datetime.now(timezone.utc) - timedelta(hours=48)
    deals = mt5.history_deals_get(since, datetime.now(timezone.utc) + timedelta(hours=1))
    if not deals:
        return

    closed = set()
    for deal in deals:
        if deal.magic != MAGIC or deal.entry != mt5.DEAL_ENTRY_OUT:
            continue
        if deal.position_id not in open_tickets:
            continue

        meta   = open_tickets[deal.position_id]
        pnl    = round(deal.profit + deal.commission + deal.swap, 2)
        result = "WIN" if pnl > 0 else "LOSS"

        payload = {
            "id":         meta["db_id"],
            "symbol":     meta["symbol"],
            "direction":  meta["direction"],
            "entry":      meta["entry"],
            "exit_price": round(deal.price, 5),
            "pnl_usd":    pnl,
            "result":     result,
            "lots":       meta["lots"],
            "source":     "mt5_bridge",
        }
        r.publish("TRADE_CLOSED", json.dumps(payload))
        log.info("📤 TRADE_CLOSED  #%s  %s  P&L=$%.2f  [%s]%s",
                 meta["db_id"], meta["symbol"], pnl, result,
                 "  🎯 trailed" if meta.get("be_done") else "")
        closed.add(deal.position_id)

    for t in closed:
        open_tickets.pop(t, None)


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
