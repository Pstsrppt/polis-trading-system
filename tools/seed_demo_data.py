#!/usr/bin/env python3
"""Insert realistic demo data into POLIS PostgreSQL for UI testing.

Usage:
    python tools/seed_demo_data.py              # uses .env in project root
    python tools/seed_demo_data.py --clear      # wipe existing data first
    python tools/seed_demo_data.py --days 30    # 30 days of history
"""
import argparse
import asyncio
import json
import os
import random
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

env_path = Path(__file__).parent.parent / ".env"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())

try:
    import asyncpg
except ImportError:
    sys.exit("asyncpg not installed — run: pip install asyncpg")

POSTGRES_URL = os.getenv("POSTGRES_URL", "postgresql://polis:polis@localhost:5432/polis")

# Gold price range — realistic for mid-2026 (~4000–4300)
GOLD_BASE   = 4150.0
GOLD_RANGE  = 150.0   # ±150 over 30 days

SYMBOLS    = ["XAUUSD", "XAUUSD", "XAUUSD", "EURUSD", "GBPUSD", "BTCUSD"]
DIRECTIONS = ["long", "short"]
OUTCOMES   = ["APPROVED", "APPROVED", "APPROVED", "BLOCKED"]   # 75% approve
RESULTS    = ["WIN", "WIN", "LOSS"]                             # 67% win

# Per-symbol price config (base, daily_range, units_per_lot)
SYMBOL_PRICE: dict[str, dict] = {
    "XAUUSD": {"base": GOLD_BASE, "range": GOLD_RANGE, "units": 100,     "decimals": 2},
    "EURUSD": {"base": 1.085,     "range": 0.015,      "units": 100_000, "decimals": 5},
    "GBPUSD": {"base": 1.270,     "range": 0.018,      "units": 100_000, "decimals": 5},
    "BTCUSD": {"base": 62_000,    "range": 3_000,      "units": 1,       "decimals": 2},
}
REASONS    = [
    "Strong momentum with ATR confirmation",
    "Bullish sentiment aligned with DXY weakness",
    "Research confidence above threshold",
    "Gold breakout above key resistance",
    "Bearish divergence on H4",
    "Risk-reward ratio exceeds minimum",
    "EMA 5/20 crossover confirmed on H1",
    "Macro tailwinds: Fed dovish pivot expected",
]
BLOCK_REASONS = [
    "Confidence below minimum threshold (58%)",
    "ATR/spread ratio too low",
    "Circuit breaker consecutive reject limit",
    "Trading hours restriction",
    "Max daily notional reached",
    "Correlation group limit reached",
]
RESOLUTIONS = ["loosen", "loosen", "hold", "hold", "tighten"]
DIRECTIVES  = [
    "Macro conditions supportive — maintain current risk parameters with slight loosening",
    "Mixed signals from DXY and gold correlation — hold current stance",
    "Elevated volatility detected — tighten risk thresholds by 20%",
    "Fear & Greed reading bullish — increase position tolerance",
    "Board consensus: maintain current policy pending next Fed announcement",
    "DXY weakness accelerating — loosen gold exposure limits",
]
EXEC_VIEWS_TEMPLATES = [
    {"ceo": "LOOSEN", "cto": "LOOSEN", "cfo": "HOLD",    "coo": "LOOSEN",  "cmo": "LOOSEN"},
    {"ceo": "HOLD",   "cto": "HOLD",   "cfo": "HOLD",    "coo": "HOLD",    "cmo": "HOLD"},
    {"ceo": "TIGHTEN","cto": "HOLD",   "cfo": "TIGHTEN", "coo": "TIGHTEN", "cmo": "HOLD"},
    {"ceo": "LOOSEN", "cto": "LOOSEN", "cfo": "TIGHTEN", "coo": "HOLD",    "cmo": "LOOSEN"},
]


def rand_price(symbol: str, day_offset: int, total_days: int) -> float:
    """Return a realistic price for the symbol that trends over the period."""
    cfg   = SYMBOL_PRICE.get(symbol, SYMBOL_PRICE["XAUUSD"])
    t     = 1.0 - (day_offset / max(total_days, 1))
    trend = (t - 0.5) * cfg["range"] * 2
    noise = random.uniform(-cfg["range"] * 0.2, cfg["range"] * 0.2)
    return round(cfg["base"] + trend + noise, cfg["decimals"])


def rand_lots(symbol: str) -> float:
    if symbol == "BTCUSD":
        return round(random.choice([0.01, 0.02, 0.05, 0.10]), 2)
    if symbol in ("EURUSD", "GBPUSD"):
        return round(random.choice([0.10, 0.20, 0.30, 0.50]), 2)
    return round(random.choice([0.01, 0.02, 0.03, 0.05]), 2)


def rand_stop(symbol: str, price: float) -> float:
    cfg = SYMBOL_PRICE.get(symbol, SYMBOL_PRICE["XAUUSD"])
    return round(random.uniform(price * 0.002, price * 0.005), cfg["decimals"])


def rand_confidence() -> int:
    return random.randint(60, 92)


def pnl_from_result(result: str, lots: float, symbol: str) -> float:
    units = SYMBOL_PRICE.get(symbol, SYMBOL_PRICE["XAUUSD"])["units"]
    if result == "WIN":
        return round(random.uniform(0.0002, 0.0025) * lots * units, 2)
    return round(-random.uniform(0.0001, 0.0012) * lots * units, 2)


async def clear_tables(conn) -> None:
    await conn.execute("DELETE FROM board_resolutions")
    await conn.execute("DELETE FROM trade_decisions")
    print("  Tables cleared.")


async def seed_trades(conn, days: int) -> int:
    now  = datetime.now(timezone.utc)
    rows = 0

    for d in range(days, 0, -1):
        base      = now - timedelta(days=d)
        n_signals = random.randint(6, 18)

        for i in range(n_signals):
            minutes_offset = random.randint(0, 1380)
            created_at = base.replace(hour=7, minute=0, second=0, microsecond=0) + timedelta(minutes=minutes_offset)
            symbol    = random.choice(SYMBOLS)
            direction = random.choice(DIRECTIONS)
            outcome   = random.choice(OUTCOMES)
            price     = rand_price(symbol, d, days)
            lots      = rand_lots(symbol)
            stop      = rand_stop(symbol, price)
            confidence = rand_confidence() if outcome == "APPROVED" else random.randint(40, 59)
            reason    = random.choice(REASONS if outcome == "APPROVED" else BLOCK_REASONS)
            units     = SYMBOL_PRICE.get(symbol, SYMBOL_PRICE["XAUUSD"])["units"]
            risk_usd  = round(stop * lots * units, 2) if outcome == "APPROVED" else None

            trade_result = None
            exit_price   = None
            exit_at      = None
            pnl_usd      = None

            if outcome == "APPROVED":
                result       = random.choice(RESULTS)
                trade_result = result
                hold_mins    = random.randint(15, 240)
                exit_at      = created_at + timedelta(minutes=hold_mins)
                cfg_d        = SYMBOL_PRICE.get(symbol, SYMBOL_PRICE["XAUUSD"])
                move         = random.uniform(price * 0.001, price * 0.004)
                if result == "WIN":
                    exit_price = round(price + move if direction == "long" else price - move, cfg_d["decimals"])
                else:
                    exit_price = round(price - move * 0.55 if direction == "long" else price + move * 0.55, cfg_d["decimals"])
                pnl_usd = pnl_from_result(result, lots, symbol)

            await conn.execute(
                """INSERT INTO trade_decisions
                   (task_id, symbol, direction, price, risk, stop, lots, risk_usd, outcome,
                    confidence, reason, exit_price, exit_at, pnl_usd, trade_result, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)""",
                f"seed-{d}-{i}", symbol, direction, price,
                round(stop / price, 5), stop, lots, risk_usd, outcome,
                confidence, reason,
                exit_price, exit_at, pnl_usd, trade_result, created_at,
            )
            rows += 1

    return rows


async def seed_resolutions(conn, days: int) -> int:
    now  = datetime.now(timezone.utc)
    rows = 0
    for d in range(days, 0, -1):
        base    = now - timedelta(days=d)
        n_board = random.randint(2, 5)
        for i in range(n_board):
            hours   = random.randint(7, 22)
            created = base.replace(hour=hours, minute=random.randint(0, 59), second=0, microsecond=0)
            res     = random.choice(RESOLUTIONS)
            views_t = random.choice(EXEC_VIEWS_TEMPLATES)
            views   = {
                role: {"vote": vote, "assessment": random.choice(DIRECTIVES)}
                for role, vote in views_t.items()
            }
            n = random.randint(8, 20)
            ap = random.randint(int(n * 0.5), int(n * 0.85))
            await conn.execute(
                """INSERT INTO board_resolutions
                   (resolution, directive, confidence, metrics, exec_views, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6)""",
                res,
                random.choice(DIRECTIVES),
                random.randint(62, 92),
                json.dumps({
                    "total":         n,
                    "approved":      ap,
                    "blocked":       n - ap,
                    "approval_rate": round(ap / n * 100, 1),
                    "avg_confidence": round(random.uniform(68, 84), 1),
                    "period_minutes": 5,
                }),
                json.dumps(views),
                created,
            )
            rows += 1
    return rows


async def main(days: int, clear: bool) -> None:
    print(f"\n  POLIS Demo Data Seeder  (symbols: {', '.join(set(SYMBOLS))})")
    print(f"  Connecting to: {POSTGRES_URL[:50]}…\n")

    try:
        conn = await asyncpg.connect(POSTGRES_URL)
    except Exception as e:
        sys.exit(f"  Cannot connect to PostgreSQL: {e}")

    if clear:
        await clear_tables(conn)

    print(f"  Seeding {days} days of history…")
    t = await seed_trades(conn, days)
    b = await seed_resolutions(conn, days)
    await conn.close()

    print(f"  ✓ {t} trade decisions inserted")
    print(f"  ✓ {b} board resolutions inserted")
    print(f"\n  Open http://localhost:3000 to see demo data!\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed POLIS demo data")
    parser.add_argument("--days",  type=int, default=30, help="Days of history (default 30)")
    parser.add_argument("--clear", action="store_true",  help="Wipe existing data first")
    args = parser.parse_args()
    asyncio.run(main(args.days, args.clear))
