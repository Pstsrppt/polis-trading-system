"""POLIS Backtester — replay EMA strategy on historical TwelveData bars.

Tests the full signal pipeline (filter + TP/SL) without LLM or live broker.
Prints a detailed P&L report at the end.

Run:
    python tools/backtest.py
    python tools/backtest.py --symbol EUR/USD --days 60
    python tools/backtest.py --symbol XAU/USD --days 90 --rr 2.5

Options:
    --symbol  XAU/USD          (default: XAU/USD)
    --days    30-500           (default: 90)
    --rr      reward/risk ratio (default: 2.0)
    --conf    min confidence    (default: 60)
"""
import argparse
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("backtest")

API_KEY  = os.environ["TWELVE_DATA_API_KEY"]
BASE_URL = "https://api.twelvedata.com"

SYMBOL_CONFIG = {
    "XAU/USD": {"atr": 0.003,  "spread": 0.00005,  "name": "XAUUSD", "units": 100},
    "EUR/USD": {"atr": 0.0008, "spread": 0.000015, "name": "EURUSD", "units": 100_000},
    "GBP/USD": {"atr": 0.0010, "spread": 0.000020, "name": "GBPUSD", "units": 100_000},
    "BTC/USD": {"atr": 0.003,  "spread": 0.0002,   "name": "BTCUSD", "units": 1},
}


# ── data fetching ──────────────────────────────────────────────
def fetch_bars(symbol: str, days: int) -> list[dict]:
    outputsize = min(days * 24, 5000)   # 1h bars
    log.info("Fetching %d bars for %s …", outputsize, symbol)
    r = requests.get(
        f"{BASE_URL}/time_series",
        params={"symbol": symbol, "interval": "1h",
                "outputsize": outputsize, "apikey": API_KEY},
        timeout=30,
    )
    data = r.json()
    if "values" not in data:
        raise RuntimeError(f"TwelveData error: {data}")
    bars = list(reversed(data["values"]))
    log.info("Got %d bars (%s → %s)", len(bars),
             bars[0]["datetime"], bars[-1]["datetime"])
    return bars


# ── indicators ────────────────────────────────────────────────
def _ema(closes: list[float], period: int) -> list[float]:
    k   = 2 / (period + 1)
    out = [closes[0]]
    for v in closes[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def _atr(bars: list[dict], period: int = 14) -> list[float]:
    trs = [float(bars[0]["high"]) - float(bars[0]["low"])]
    for i in range(1, len(bars)):
        h  = float(bars[i]["high"])
        l  = float(bars[i]["low"])
        pc = float(bars[i - 1]["close"])
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    # Wilder smoothing
    out = [sum(trs[:period]) / period]
    for tr in trs[period:]:
        out.append((out[-1] * (period - 1) + tr) / period)
    return [float("nan")] * (period - 1) + out


# ── signal generation ─────────────────────────────────────────
def generate_signals(bars: list[dict], cfg: dict, min_conf: int) -> list[dict]:
    closes   = [float(b["close"]) for b in bars]
    ema5     = _ema(closes, 5)
    ema20    = _ema(closes, 20)
    atr_vals = _atr(bars)
    spread_f = cfg["spread"]

    signals = []
    for i in range(20, len(bars)):
        price     = closes[i]
        atr_val   = atr_vals[i]
        spread    = price * spread_f
        prev_bull = ema5[i - 1] <= ema20[i - 1]
        curr_bull = ema5[i]     >  ema20[i]
        prev_bear = ema5[i - 1] >= ema20[i - 1]
        curr_bear = ema5[i]     <  ema20[i]

        if not (curr_bull and prev_bull) and not (curr_bear and prev_bear):
            continue   # no crossover trend

        direction = "long" if curr_bull else "short"
        stop      = atr_val * 1.5
        if stop <= 0 or price <= 0:
            continue

        # Simulated confidence (ATR/spread quality)
        atr_spread_ratio = atr_val / max(spread, 0.0001)
        conf = min(int(50 + atr_spread_ratio * 5), 95)
        if conf < min_conf:
            continue
        if atr_spread_ratio < 2.0:
            continue

        signals.append({
            "bar_idx":   i,
            "datetime":  bars[i]["datetime"],
            "direction": direction,
            "price":     price,
            "stop":      stop,
            "atr":       atr_val,
            "spread":    spread,
            "conf":      conf,
        })
    return signals


# ── simulation ────────────────────────────────────────────────
def simulate(bars: list[dict], signals: list[dict], rr: float, lots: float, units: int = 100) -> list[dict]:
    closes  = [float(b["close"]) for b in bars]
    results = []

    for sig in signals:
        i         = sig["bar_idx"]
        entry     = sig["price"]
        stop_dist = sig["stop"]
        direction = sig["direction"]
        tp_dist   = stop_dist * rr

        sl_price = entry - stop_dist if direction == "long" else entry + stop_dist
        tp_price = entry + tp_dist   if direction == "long" else entry - tp_dist

        result    = "OPEN"
        exit_price = None

        for j in range(i + 1, len(bars)):
            c = closes[j]
            if direction == "long":
                if c <= sl_price:
                    result, exit_price = "LOSS", sl_price; break
                if c >= tp_price:
                    result, exit_price = "WIN",  tp_price; break
            else:
                if c >= sl_price:
                    result, exit_price = "LOSS", sl_price; break
                if c <= tp_price:
                    result, exit_price = "WIN",  tp_price; break

        if result == "OPEN":
            exit_price = closes[-1]

        if direction == "long":
            pnl = (exit_price - entry) * lots * units
        else:
            pnl = (entry - exit_price) * lots * units

        results.append({**sig, "result": result, "exit_price": exit_price, "pnl": round(pnl, 2)})

    return results


# ── report ────────────────────────────────────────────────────
def report(symbol: str, trades: list[dict], days: int, rr: float) -> None:
    if not trades:
        print("\n  No trades generated.")
        return

    wins   = [t for t in trades if t["result"] == "WIN"]
    losses = [t for t in trades if t["result"] == "LOSS"]
    total  = len(trades)
    closed = len(wins) + len(losses)
    win_r  = len(wins) / closed * 100 if closed > 0 else 0
    total_pnl  = sum(t["pnl"] for t in trades)
    max_win    = max((t["pnl"] for t in trades), default=0)
    max_loss   = min((t["pnl"] for t in trades), default=0)

    # Drawdown
    equity = 0.0
    peak   = 0.0
    max_dd = 0.0
    for t in trades:
        equity += t["pnl"]
        peak    = max(peak, equity)
        dd      = peak - equity
        max_dd  = max(max_dd, dd)

    # Expectancy per trade
    avg_win  = sum(t["pnl"] for t in wins)  / len(wins)  if wins  else 0
    avg_loss = sum(t["pnl"] for t in losses)/ len(losses) if losses else 0
    expect   = (win_r/100 * avg_win) + ((1 - win_r/100) * avg_loss)

    sep = "─" * 52
    print(f"\n{'═'*52}")
    print(f"  POLIS Backtest Report — {symbol}")
    print(f"  Period: {days} days  |  RR: 1:{rr}  |  Lots: fixed 0.03")
    print(f"{'═'*52}")
    print(f"\n  {'Trades':25s} {total:>8}")
    print(f"  {'Closed':25s} {closed:>8}")
    print(f"  {'Win Rate':25s} {win_r:>7.1f}%")
    print(f"  {'Wins':25s} {len(wins):>8}")
    print(f"  {'Losses':25s} {len(losses):>8}")
    print(f"\n{sep}")
    pnl_sign = "+" if total_pnl >= 0 else ""
    print(f"  {'Total P&L':25s} {pnl_sign}${total_pnl:>7.2f}")
    print(f"  {'Best trade':25s} +${max_win:>6.2f}")
    print(f"  {'Worst trade':25s}  ${max_loss:>6.2f}")
    print(f"  {'Avg Win':25s} +${avg_win:>6.2f}")
    print(f"  {'Avg Loss':25s}  ${avg_loss:>6.2f}")
    print(f"  {'Expectancy/trade':25s} {'+' if expect>=0 else ''}${expect:>6.2f}")
    print(f"\n{sep}")
    print(f"  {'Max Drawdown':25s}  ${max_dd:>6.2f}")
    verdict = "✅ PROFITABLE" if total_pnl > 0 else "❌ NOT PROFITABLE"
    print(f"\n  {verdict}")
    print(f"{'═'*52}\n")

    # Last 5 trades
    print("  Last 5 trades:")
    for t in trades[-5:]:
        icon = "✅" if t["result"] == "WIN" else "❌" if t["result"] == "LOSS" else "○"
        pnl_s = f"{'+' if t['pnl']>=0 else ''}${t['pnl']:.2f}"
        print(f"    {icon} {t['datetime'][:16]}  {t['direction'].upper():<5}  "
              f"entry=${t['price']:.2f}  {pnl_s:>9}")
    print()


# ── main ──────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(description="POLIS Backtester")
    parser.add_argument("--symbol", default="XAU/USD",  help="e.g. XAU/USD, EUR/USD, BTC/USD")
    parser.add_argument("--days",   type=int, default=90,  help="Days of history (default 90)")
    parser.add_argument("--rr",     type=float, default=2.0, help="Reward/risk ratio (default 2.0)")
    parser.add_argument("--conf",   type=int, default=60,  help="Min confidence (default 60)")
    parser.add_argument("--lots",   type=float, default=0.03, help="Fixed lot size (default 0.03)")
    args = parser.parse_args()

    cfg = SYMBOL_CONFIG.get(args.symbol, {"atr": 0.003, "spread": 0.00005, "name": args.symbol, "units": 100})

    bars    = fetch_bars(args.symbol, args.days)
    signals = generate_signals(bars, cfg, args.conf)
    log.info("Generated %d signals from %d bars", len(signals), len(bars))

    trades  = simulate(bars, signals, args.rr, args.lots, units=cfg.get("units", 100))
    report(args.symbol, trades, args.days, args.rr)


if __name__ == "__main__":
    main()
