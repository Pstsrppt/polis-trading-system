"""Postgres client — single connection pool shared across the kernel."""
import logging
import os

import asyncpg

log = logging.getLogger("kernel.db")

_pool: asyncpg.Pool | None = None

DDL = """
CREATE TABLE IF NOT EXISTS trade_decisions (
    id              SERIAL PRIMARY KEY,
    task_id         TEXT        NOT NULL,
    symbol          TEXT        NOT NULL,
    direction       TEXT        NOT NULL,
    price           NUMERIC,
    risk            NUMERIC,
    stop            NUMERIC,
    lots            NUMERIC,
    outcome         TEXT        NOT NULL,
    confidence      INTEGER,
    reason          TEXT,
    broker_order_id TEXT,
    fill_price      NUMERIC,
    exit_price      NUMERIC,
    exit_at         TIMESTAMPTZ,
    pnl_usd         NUMERIC,
    trade_result    TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE trade_decisions ADD COLUMN IF NOT EXISTS lots NUMERIC;
ALTER TABLE trade_decisions ADD COLUMN IF NOT EXISTS risk_usd NUMERIC;
ALTER TABLE trade_decisions ADD COLUMN IF NOT EXISTS broker_order_id TEXT;
ALTER TABLE trade_decisions ADD COLUMN IF NOT EXISTS fill_price NUMERIC;
ALTER TABLE trade_decisions ADD COLUMN IF NOT EXISTS exit_price NUMERIC;
ALTER TABLE trade_decisions ADD COLUMN IF NOT EXISTS exit_at TIMESTAMPTZ;
ALTER TABLE trade_decisions ADD COLUMN IF NOT EXISTS pnl_usd NUMERIC;
ALTER TABLE trade_decisions ADD COLUMN IF NOT EXISTS trade_result TEXT;
CREATE TABLE IF NOT EXISTS board_resolutions (
    id          SERIAL PRIMARY KEY,
    resolution  TEXT        NOT NULL,
    directive   TEXT        NOT NULL,
    confidence  INTEGER,
    metrics     JSONB,
    exec_views  JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
"""


async def init() -> None:
    global _pool
    url = os.environ["POSTGRES_URL"]
    _pool = await asyncpg.create_pool(url, min_size=1, max_size=5)
    async with _pool.acquire() as conn:
        await conn.execute(DDL)
    log.info("Postgres pool ready")


async def save_decision(
    task_id: str,
    symbol: str,
    direction: str,
    outcome: str,
    price: float | None = None,
    risk: float | None = None,
    stop: float | None = None,
    confidence: int | None = None,
    reason: str | None = None,
    lots: float | None = None,
    risk_usd: float | None = None,
    broker_order_id: str | None = None,
    fill_price: float | None = None,
) -> int | None:
    """Insert a trade decision and return the new row ID."""
    if _pool is None:
        log.warning("DB not initialised — skipping save")
        return None
    async with _pool.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO trade_decisions
               (task_id, symbol, direction, price, risk, stop, lots, risk_usd,
                outcome, confidence, reason, broker_order_id, fill_price)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
               RETURNING id""",
            task_id, symbol, direction, price, risk, stop, lots, risk_usd,
            outcome, confidence, reason, broker_order_id, fill_price,
        )
    return row["id"] if row else None


async def recent_decisions(limit: int = 50) -> list[dict]:
    if _pool is None:
        return []
    async with _pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM trade_decisions ORDER BY created_at DESC LIMIT $1", limit
        )
    return [dict(r) for r in rows]


async def recent_metrics(minutes: int = 5) -> dict:
    if _pool is None:
        return {"total": 0, "approved": 0, "blocked": 0, "approval_rate": 0.0, "avg_confidence": 0.0}
    async with _pool.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT
                COUNT(*)                                        AS total,
                COUNT(*) FILTER (WHERE outcome='APPROVED')     AS approved,
                COUNT(*) FILTER (WHERE outcome='BLOCKED')      AS blocked,
                ROUND(AVG(confidence) FILTER (WHERE confidence IS NOT NULL), 1) AS avg_confidence
               FROM trade_decisions
               WHERE created_at > NOW() - ($1 || ' minutes')::INTERVAL""",
            str(minutes),
        )
        sym_rows = await conn.fetch(
            """SELECT symbol,
                COUNT(*)                                    AS total,
                COUNT(*) FILTER (WHERE outcome='APPROVED') AS approved,
                COUNT(*) FILTER (WHERE outcome='BLOCKED')  AS blocked
               FROM trade_decisions
               WHERE created_at > NOW() - ($1 || ' minutes')::INTERVAL
               GROUP BY symbol ORDER BY total DESC""",
            str(minutes),
        )
    total    = row["total"] or 0
    approved = row["approved"] or 0
    return {
        "total":          total,
        "approved":       approved,
        "blocked":        row["blocked"] or 0,
        "approval_rate":  round(approved / total * 100, 1) if total else 0.0,
        "avg_confidence": float(row["avg_confidence"] or 0),
        "period_minutes": minutes,
        "by_symbol": {
            r["symbol"]: {
                "total":    r["total"],
                "approved": r["approved"],
                "blocked":  r["blocked"],
            }
            for r in sym_rows
        },
    }


async def closed_trade_report() -> dict:
    """P&L summary for all closed trades (trade_result IS NOT NULL)."""
    if _pool is None:
        return {}
    async with _pool.acquire() as conn:
        all_time = await conn.fetchrow(
            """SELECT
                COUNT(*)                                        AS total,
                COUNT(*) FILTER (WHERE trade_result='WIN')     AS wins,
                COUNT(*) FILTER (WHERE trade_result='LOSS')    AS losses,
                COALESCE(SUM(pnl_usd), 0)                      AS total_pnl,
                COALESCE(MAX(pnl_usd), 0)                      AS best,
                COALESCE(MIN(pnl_usd), 0)                      AS worst,
                COALESCE(AVG(pnl_usd) FILTER
                    (WHERE trade_result='WIN'),  0)             AS avg_win,
                COALESCE(AVG(pnl_usd) FILTER
                    (WHERE trade_result='LOSS'), 0)             AS avg_loss
               FROM trade_decisions
               WHERE trade_result IS NOT NULL"""
        )
        today = await conn.fetchrow(
            """SELECT
                COUNT(*)                                        AS total,
                COUNT(*) FILTER (WHERE trade_result='WIN')     AS wins,
                COALESCE(SUM(pnl_usd), 0)                      AS pnl
               FROM trade_decisions
               WHERE trade_result IS NOT NULL
                 AND (created_at AT TIME ZONE 'Asia/Bangkok')::date
                   = (NOW() AT TIME ZONE 'Asia/Bangkok')::date"""
        )
        recent = await conn.fetch(
            """SELECT direction, symbol, price, exit_price, pnl_usd, trade_result, created_at
               FROM trade_decisions
               WHERE trade_result IS NOT NULL
               ORDER BY exit_at DESC LIMIT 5"""
        )
    return {
        "all": dict(all_time),
        "today": dict(today),
        "recent": [dict(r) for r in recent],
    }


async def get_open_trades() -> list[dict]:
    """Return all APPROVED trades that have not been closed yet."""
    if _pool is None:
        return []
    async with _pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, symbol, direction, price, stop, lots
               FROM trade_decisions
               WHERE outcome = 'APPROVED' AND trade_result IS NULL
               ORDER BY created_at DESC
               LIMIT 50"""
        )
    return [
        {
            **dict(r),
            "price": float(r["price"] or 0),
            "stop":  float(r["stop"]  or 0),
            "lots":  float(r["lots"]  or 0),
        }
        for r in rows
    ]


async def close_trade(
    trade_id: int,
    exit_price: float,
    pnl_usd: float,
    trade_result: str,
) -> None:
    """Mark a trade as WIN or LOSS with exit price and P&L."""
    if _pool is None:
        return
    async with _pool.acquire() as conn:
        await conn.execute(
            """UPDATE trade_decisions
               SET exit_price = $1, exit_at = NOW(), pnl_usd = $2, trade_result = $3
               WHERE id = $4""",
            exit_price, pnl_usd, trade_result, trade_id,
        )


async def yesterday_summary() -> dict:
    """Pull yesterday's stats using Asia/Bangkok timezone."""
    if _pool is None:
        return {}
    async with _pool.acquire() as conn:
        trade_row = await conn.fetchrow(
            """SELECT
                COUNT(*)                                             AS total,
                COUNT(*) FILTER (WHERE outcome='APPROVED')          AS approved,
                COUNT(*) FILTER (WHERE outcome='BLOCKED')           AS blocked,
                ROUND(AVG(confidence) FILTER
                    (WHERE confidence IS NOT NULL), 1)              AS avg_confidence,
                MAX(confidence) FILTER (WHERE confidence IS NOT NULL) AS max_confidence,
                COALESCE(SUM(lots * CASE symbol
                    WHEN 'XAUUSD' THEN 100
                    WHEN 'EURUSD' THEN 100000
                    WHEN 'GBPUSD' THEN 100000
                    WHEN 'BTCUSD' THEN 1
                    WHEN 'XAGUSD' THEN 5000
                    ELSE 100 END * price)
                    FILTER (WHERE outcome='APPROVED'), 0)           AS total_notional
               FROM trade_decisions
               WHERE (created_at AT TIME ZONE 'Asia/Bangkok')::date
                   = (NOW() AT TIME ZONE 'Asia/Bangkok')::date - 1"""
        )
        board_rows = await conn.fetch(
            """SELECT resolution, COUNT(*) AS cnt
               FROM board_resolutions
               WHERE (created_at AT TIME ZONE 'Asia/Bangkok')::date
                   = (NOW() AT TIME ZONE 'Asia/Bangkok')::date - 1
               GROUP BY resolution"""
        )
        sym_rows = await conn.fetch(
            """SELECT symbol,
                COUNT(*)                                    AS total,
                COUNT(*) FILTER (WHERE outcome='APPROVED') AS approved,
                COUNT(*) FILTER (WHERE outcome='BLOCKED')  AS blocked
               FROM trade_decisions
               WHERE (created_at AT TIME ZONE 'Asia/Bangkok')::date
                   = (NOW() AT TIME ZONE 'Asia/Bangkok')::date - 1
               GROUP BY symbol ORDER BY total DESC"""
        )
    total    = trade_row["total"]    or 0
    approved = trade_row["approved"] or 0
    board    = {r["resolution"]: r["cnt"] for r in board_rows}
    return {
        "total":          total,
        "approved":       approved,
        "blocked":        trade_row["blocked"]        or 0,
        "approval_rate":  round(approved / total * 100, 1) if total else 0.0,
        "avg_confidence": float(trade_row["avg_confidence"] or 0),
        "max_confidence": int(trade_row["max_confidence"]   or 0),
        "total_notional": float(trade_row["total_notional"] or 0),
        "board":          board,
        "by_symbol": {
            r["symbol"]: {
                "total":    r["total"],
                "approved": r["approved"],
                "blocked":  r["blocked"],
            }
            for r in sym_rows
        },
    }


async def save_resolution(res: dict) -> None:
    if _pool is None:
        return
    import json
    async with _pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO board_resolutions (resolution, directive, confidence, metrics, exec_views)
               VALUES ($1,$2,$3,$4,$5)""",
            res["resolution"], res["directive"], res.get("confidence"),
            json.dumps(res.get("metrics", {})),
            json.dumps(res.get("exec_views", {})),
        )


async def recent_resolutions(limit: int = 10) -> list[dict]:
    if _pool is None:
        return []
    async with _pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM board_resolutions ORDER BY created_at DESC LIMIT $1", limit
        )
    return [
        {**dict(r), "created_at": r["created_at"].isoformat(),
         "metrics": dict(r["metrics"]), "exec_views": dict(r["exec_views"])}
        for r in rows
    ]
