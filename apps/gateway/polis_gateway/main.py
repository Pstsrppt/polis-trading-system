"""Public API + WebSocket. Bridges Redis pub/sub to the dashboard."""
import asyncio
import json
import logging
import os
from collections import deque
from datetime import datetime, timezone

import asyncpg
import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("gateway")

_clients: list[WebSocket] = []
_recent: deque[dict] = deque(maxlen=100)
_listener_started  = False
_scheduler_started = False
_pg: asyncpg.Pool | None = None
_redis_pub: aioredis.Redis | None = None

REDIS_URL    = os.getenv("REDIS_URL", "redis://redis:6379/0")
POSTGRES_URL = os.getenv("POSTGRES_URL", "postgresql://polis:polis@postgres:5432/polis")
TV_SECRET    = os.getenv("TRADINGVIEW_WEBHOOK_SECRET", "")

# Units per lot for each instrument (used for notional calculations)
_UNITS_PER_LOT: dict[str, int] = {
    "XAUUSD": 100,
    "EURUSD": 100_000,
    "GBPUSD": 100_000,
    "BTCUSD": 1,
    "XAGUSD": 5_000,
}


async def _get_pub() -> aioredis.Redis:
    global _redis_pub
    if _redis_pub is None:
        _redis_pub = aioredis.from_url(REDIS_URL)
    return _redis_pub

TOPICS = [
    "AGENT_HIRED", "AGENT_FIRED",
    "TASK_COMPLETED", "TASK_FAILED",
    "POLICY_BLOCKED", "TRADE_SIGNAL",
    "RESEARCH_COMPLETE", "SIGNAL_APPROVED", "SIGNAL_REJECTED",
    "TRADE_APPROVED", "TRADE_CLOSED",
    "BOARD_MEETING", "BOARD_RESOLUTION",
    "POLICY_ADJUSTED", "HEALTH_TICK",
    "TRADING_PAUSED", "TRADING_RESUMED", "RISK_OVERRIDE", "BOARD_TRIGGER",
    "WORLD_UPDATE", "SETTINGS_UPDATE",
    "CIRCUIT_BREAKER_TRIGGERED", "CIRCUIT_BREAKER_RESET",
]

_WORLD_KEY    = "polis:world"
_LLM_COST_KEY = "polis:llm_costs"

app = FastAPI(title="POLIS Gateway", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


_SIGNAL_SUBSCRIBERS_DDL = """
CREATE TABLE IF NOT EXISTS signal_subscribers (
    id            SERIAL PRIMARY KEY,
    telegram_id   BIGINT NOT NULL UNIQUE,
    username      TEXT,
    plan          TEXT NOT NULL DEFAULT 'monthly',
    status        TEXT NOT NULL DEFAULT 'active',
    expires_at    TIMESTAMPTZ,
    paid_amount   NUMERIC DEFAULT 0,
    notes         TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS signal_broadcasts (
    id            SERIAL PRIMARY KEY,
    trade_id      INTEGER,
    symbol        TEXT,
    direction     TEXT,
    entry_price   NUMERIC,
    stop          NUMERIC,
    tp            NUMERIC,
    lots          NUMERIC,
    confidence    INTEGER,
    risk_usd      NUMERIC,
    sent_count    INTEGER DEFAULT 0,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
"""

_SUBSCRIBE_REQUESTS_DDL = """
CREATE TABLE IF NOT EXISTS subscribe_requests (
    id            SERIAL PRIMARY KEY,
    telegram_id   BIGINT,
    username      TEXT NOT NULL,
    plan          TEXT NOT NULL DEFAULT 'monthly',
    amount_thb    NUMERIC NOT NULL,
    slip_note     TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    approved_by   TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);
"""

_CONTENT_QUEUE_DDL = """
CREATE TABLE IF NOT EXISTS content_queue (
    id            TEXT PRIMARY KEY,
    source        TEXT NOT NULL,
    type          TEXT NOT NULL DEFAULT 'text',
    platforms     JSONB NOT NULL DEFAULT '[]',
    title         TEXT,
    caption       TEXT,
    hashtags      JSONB DEFAULT '[]',
    asset_url     TEXT,
    thumbnail_url TEXT,
    scheduled_at  TIMESTAMPTZ,
    status        TEXT NOT NULL DEFAULT 'queued',
    published_urls JSONB DEFAULT '{}',
    metadata      JSONB DEFAULT '{}',
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
"""

_pg_migrated = False


async def _ensure_pg() -> asyncpg.Pool | None:
    global _pg, _pg_migrated
    if _pg is None:
        try:
            _pg = await asyncpg.create_pool(POSTGRES_URL, min_size=1, max_size=3)
        except Exception as exc:
            log.error("Postgres unavailable: %s", exc)
    if _pg and not _pg_migrated:
        try:
            async with _pg.acquire() as conn:
                await conn.execute(_CONTENT_QUEUE_DDL)
                await conn.execute(_SIGNAL_SUBSCRIBERS_DDL)
                await conn.execute(_SUBSCRIBE_REQUESTS_DDL)
            _pg_migrated = True
            log.info("DB tables ready")
        except Exception as exc:
            log.warning("content_queue DDL failed: %s", exc)
    return _pg


async def _broadcast(frame: str) -> None:
    _recent.append(json.loads(frame))
    dead = []
    for ws in _clients:
        try:
            await ws.send_text(frame)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _clients.remove(ws)


async def _scheduled_post_worker() -> None:
    """Run every 60s — publish content_queue items whose scheduled_at has passed."""
    import httpx as _httpx2  # noqa: PLC0415
    log.info("Scheduled post worker started")
    while True:
        await asyncio.sleep(60)
        try:
            pool = await _ensure_pg()
            if pool is None:
                continue
            async with pool.acquire() as conn:
                due = await conn.fetch(
                    """SELECT id, title, platforms FROM content_queue
                       WHERE status = 'scheduled'
                         AND scheduled_at <= NOW()
                       LIMIT 10"""
                )
            for row in due:
                item_id = row["id"]
                log.info("Scheduled post due: %s — %s", item_id, row["title"])
                try:
                    async with _httpx2.AsyncClient(timeout=120.0) as client:
                        r = await client.post(
                            f"http://localhost:{os.getenv('PORT','8000')}/social/queue/{item_id}/publish"
                        )
                        if r.status_code == 200:
                            log.info("Scheduled post published: %s", item_id)
                        else:
                            log.warning("Scheduled post failed %s: %s", item_id, r.text[:100])
                except Exception as exc:
                    log.warning("Scheduled post error %s: %s", item_id, exc)
        except Exception as exc:
            log.warning("Scheduled worker error: %s", exc)


def _fmt_price(v: float) -> str:
    if v < 10:   return f"${v:.5g}"
    if v < 1000: return f"${v:,.2f}"
    return f"${v:,.0f}"


async def _auto_queue_trade_post(data: dict) -> None:
    """When a trade closes, auto-generate a social post and add to content queue."""
    try:
        pool = await _ensure_pg()
        if pool is None:
            return

        symbol    = data.get("symbol", "?")
        direction = str(data.get("direction", "")).upper()
        entry     = float(data.get("entry",      0))
        exit_p    = float(data.get("exit_price", 0))
        pnl       = float(data.get("pnl_usd",    0))
        result    = data.get("result", "")
        lots      = float(data.get("lots",        0))

        icon     = "✅" if result == "WIN" else "❌"
        pnl_str  = f"+${pnl:.0f}" if pnl >= 0 else f"-${abs(pnl):.0f}"
        dir_word = "LONG 📈" if direction == "LONG" else "SHORT 📉"

        caption = (
            f"{icon} POLIS AI just closed a trade\n\n"
            f"📌 {dir_word} {symbol}\n"
            f"🔵 Entry: {_fmt_price(entry)}\n"
            f"🔴 Exit:  {_fmt_price(exit_p)}\n"
            f"💰 P&L:   {pnl_str}\n"
            f"📦 Size:  {lots:.2f} lots\n\n"
            f"Powered by POLIS AI Trading OS"
        )
        hashtags = ["AITrading", "POLIS", symbol.lower(), "Forex", "Trading",
                    "GoldTrading" if "XAU" in symbol else "CryptoTrading"]

        import uuid as _uuid2  # noqa: PLC0415
        item_id = str(_uuid2.uuid4())
        await pool.execute(
            """INSERT INTO content_queue
               (id, source, type, platforms, title, caption, hashtags, metadata)
               VALUES ($1,'trading','text',$2::jsonb,$3,$4,$5::jsonb,$6::jsonb)""",
            item_id,
            json.dumps(["twitter", "linkedin", "instagram"]),
            f"{icon} {direction} {symbol} — {pnl_str}",
            caption,
            json.dumps(hashtags),
            json.dumps({"symbol": symbol, "direction": direction,
                        "pnl_usd": pnl, "result": result}),
        )
        log.info("Auto-queued trade post: %s %s %s", result, symbol, pnl_str)
    except Exception as exc:
        log.warning("Auto-queue trade post failed: %s", exc)


async def _redis_listener() -> None:
    log.info("Redis listener starting…")
    while True:
        try:
            r = aioredis.from_url(REDIS_URL)
            pubsub = r.pubsub()
            await pubsub.subscribe(*TOPICS)
            log.info("Subscribed to %d topics", len(TOPICS))
            async for message in pubsub.listen():
                if message["type"] != "message":
                    continue
                topic = message["channel"].decode()
                try:
                    data = json.loads(message["data"])
                except Exception:
                    continue
                frame = json.dumps({
                    "topic": topic,
                    "data": data,
                    "ts": datetime.now(timezone.utc).isoformat(),
                })
                log.info("EVENT %s", topic)
                await _broadcast(frame)
                # Auto-generate social post when a trade closes
                if topic == "TRADE_CLOSED":
                    asyncio.create_task(_auto_queue_trade_post(data))
        except Exception as exc:
            log.error("Listener error (reconnecting in 3s): %s", exc)
            await asyncio.sleep(3)


@app.middleware("http")
async def ensure_listener(request, call_next):
    global _listener_started, _scheduler_started
    if not _listener_started:
        _listener_started = True
        asyncio.create_task(_redis_listener())
        log.info("Listener task auto-started")
    if not _scheduler_started:
        _scheduler_started = True
        asyncio.create_task(_scheduled_post_worker())
        log.info("Scheduled post worker auto-started")
    return await call_next(request)


@app.get("/health")
async def health() -> dict:
    return {"status": "operational", "clients": len(_clients)}


@app.get("/clients")
async def ws_clients() -> dict:
    return {"clients": len(_clients)}


@app.get("/health/services")
async def services_health() -> dict:
    import httpx as _httpx
    results: dict[str, str] = {"gateway": "ok"}

    # Redis
    try:
        r = await _get_pub()
        await asyncio.wait_for(r.ping(), timeout=2.0)
        results["redis"] = "ok"
    except Exception:
        results["redis"] = "error"

    # Postgres
    try:
        pool = await _ensure_pg()
        if pool:
            async with pool.acquire() as conn:
                await asyncio.wait_for(conn.fetchval("SELECT 1"), timeout=2.0)
            results["postgres"] = "ok"
        else:
            results["postgres"] = "error"
    except Exception:
        results["postgres"] = "error"

    # Qdrant
    try:
        async with _httpx.AsyncClient() as client:
            resp = await client.get("http://qdrant:6333/healthz", timeout=2.0)
            results["qdrant"] = "ok" if resp.status_code == 200 else "warn"
    except Exception:
        results["qdrant"] = "error"

    # Kernel — ok if polis:health key present (TTL 30s, written by HealthMonitor every 5s)
    try:
        r   = await _get_pub()
        raw = await r.get("polis:health")
        results["kernel"] = "ok" if raw else "warn"
    except Exception:
        results["kernel"] = "error"

    # World model — ok if polis:world key has been written
    try:
        r   = await _get_pub()
        raw = await r.get("polis:world")
        if raw:
            world = json.loads(raw)
            results["world_model"] = world.get("regime", "ok")
        else:
            results["world_model"] = "warn"
    except Exception:
        results["world_model"] = "error"

    # Circuit breaker
    try:
        r   = await _get_pub()
        raw = await r.hgetall("polis:circuit_breaker")
        triggered = raw.get(b"triggered", b"0") == b"1" if raw else False
        results["circuit_breaker"] = "warn" if triggered else "ok"
    except Exception:
        results["circuit_breaker"] = "error"

    return results


@app.post("/webhook/tradingview")
async def tradingview_webhook(request: Request, secret: str = "") -> dict:
    """Receive alert webhooks from TradingView and inject into TRADE_SIGNAL pipeline.

    Webhook URL format:
        https://<ngrok-url>/webhook/tradingview?secret=<TRADINGVIEW_WEBHOOK_SECRET>

    Expected JSON body (set in TradingView alert message):
        {"direction":"long","price":{{close}},"symbol":"{{ticker}}"}

    Optional fields (estimated server-side if missing):
        atr, spread, stop, risk
    """
    if TV_SECRET and secret != TV_SECRET:
        raise HTTPException(status_code=403, detail="Invalid webhook secret")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Body must be valid JSON")

    direction = str(body.get("direction", "")).lower().strip()
    if direction not in ("long", "short"):
        raise HTTPException(status_code=400, detail="direction must be 'long' or 'short'")

    try:
        price = float(body.get("price", 0))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="price must be a number")

    if price <= 0:
        raise HTTPException(status_code=400, detail="price must be > 0")

    # Use provided values or estimate from price (percentage-based — works for any symbol)
    atr    = float(body.get("atr",    price * 0.003))    # 0.3% of price — reasonable ATR estimate
    spread = float(body.get("spread", price * 0.00005))  # 0.005% of price — typical broker spread
    stop   = float(body.get("stop",   atr * 1.5))
    risk   = float(body.get("risk",   round(stop / price, 5)))

    # Normalise symbol: "XAUUSD" / "XAU/USD" / "GOLD" → "XAUUSD"
    raw_sym = str(body.get("symbol", "XAUUSD")).replace("/", "").upper()
    symbol  = raw_sym if raw_sym else "XAUUSD"

    signal = {
        "symbol":    symbol,
        "direction": direction,
        "price":     round(price, 2),
        "risk":      round(risk, 5),
        "stop":      round(stop, 2),
        "atr":       round(atr, 2),
        "spread":    round(spread, 3),
        "source":    "tradingview_webhook",
        "ts":        datetime.now(timezone.utc).isoformat(),
    }

    r = await _get_pub()
    await r.publish("TRADE_SIGNAL", json.dumps(signal))
    log.info("TradingView webhook: %s %s @ %.2f  atr=%.2f", direction.upper(), symbol, price, atr)
    return {"status": "received", "signal": signal}


@app.get("/events")
async def recent_events() -> list:
    return list(_recent)


@app.get("/resolutions")
async def resolutions(limit: int = 10) -> list:
    pool = await _ensure_pg()
    if pool is None:
        return []
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM board_resolutions ORDER BY created_at DESC LIMIT $1", limit
        )
    import json as _json
    return [
        {**dict(r), "created_at": r["created_at"].isoformat(),
         "metrics": dict(r["metrics"]), "exec_views": dict(r["exec_views"])}
        for r in rows
    ]


@app.get("/decisions")
async def decisions(limit: int = 50) -> list:
    pool = await _ensure_pg()
    if pool is None:
        return []
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM trade_decisions ORDER BY created_at DESC LIMIT $1", limit
        )
    return [
        {**dict(r), "created_at": r["created_at"].isoformat()}
        for r in rows
    ]


_CONTROL_KEY = "polis:control"


@app.get("/control/status")
async def control_status() -> dict:
    r = await _get_pub()
    paused   = await r.hget(_CONTROL_KEY, "paused")
    max_risk = await r.hget(_CONTROL_KEY, "max_risk")
    return {
        "paused":   paused == b"1",
        "max_risk": float(max_risk or 0.005),
    }


@app.post("/control/pause")
async def control_pause() -> dict:
    r = await _get_pub()
    await r.hset(_CONTROL_KEY, "paused", "1")
    await r.publish("TRADING_PAUSED", json.dumps({"ts": datetime.now(timezone.utc).isoformat()}))
    return {"status": "paused"}


@app.post("/control/resume")
async def control_resume() -> dict:
    r = await _get_pub()
    await r.hset(_CONTROL_KEY, "paused", "0")
    await r.publish("TRADING_RESUMED", json.dumps({"ts": datetime.now(timezone.utc).isoformat()}))
    return {"status": "resumed"}


@app.post("/control/risk")
async def control_risk(request: Request) -> dict:
    body = await request.json()
    value = float(body.get("max_risk", 0.005))
    value = round(max(0.002, min(0.010, value)), 4)
    r = await _get_pub()
    await r.hset(_CONTROL_KEY, "max_risk", str(value))
    await r.publish("RISK_OVERRIDE", json.dumps({"max_risk": value, "ts": datetime.now(timezone.utc).isoformat()}))
    return {"status": "ok", "max_risk": value}


@app.post("/control/board")
async def control_board() -> dict:
    r = await _get_pub()
    await r.publish("BOARD_TRIGGER", json.dumps({"forced": True, "ts": datetime.now(timezone.utc).isoformat()}))
    return {"status": "meeting triggered"}


# ── Portfolio ─────────────────────────────────────────────────────────────────

@app.get("/portfolio")
async def portfolio() -> list:
    """Open positions grouped by symbol with notional exposure."""
    pool = await _ensure_pg()
    if pool is None:
        return []
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, symbol, direction, price, stop, lots, created_at
               FROM trade_decisions
               WHERE outcome = 'APPROVED' AND trade_result IS NULL
               ORDER BY created_at DESC
               LIMIT 100"""
        )
    by_symbol: dict[str, dict] = {}
    for r in rows:
        sym = r["symbol"]
        if sym not in by_symbol:
            by_symbol[sym] = {
                "symbol":      sym,
                "trades":      [],
                "total_lots":  0.0,
                "direction":   r["direction"],
                "avg_entry":   0.0,
                "notional":    0.0,
            }
        lots  = float(r["lots"] or 0.01)
        price = float(r["price"] or 0)
        by_symbol[sym]["trades"].append({
            "id":        r["id"],
            "direction": r["direction"],
            "price":     price,
            "stop":      float(r["stop"] or 0),
            "lots":      lots,
            "created_at": r["created_at"].isoformat(),
        })
        units = _UNITS_PER_LOT.get(sym, 100)
        by_symbol[sym]["total_lots"] = round(by_symbol[sym]["total_lots"] + lots, 4)
        by_symbol[sym]["notional"]   = round(by_symbol[sym]["notional"] + lots * units * price, 2)

    for sym, pos in by_symbol.items():
        total = sum(t["price"] * t["lots"] for t in pos["trades"])
        total_lots = sum(t["lots"] for t in pos["trades"])
        pos["avg_entry"] = round(total / total_lots, 2) if total_lots else 0

    return list(by_symbol.values())


# ── World Model ───────────────────────────────────────────────────────────────

@app.get("/world")
async def world_data() -> dict:
    """Latest macro snapshot from kernel World Model."""
    r = await _get_pub()
    raw = await r.get(_WORLD_KEY)
    if raw is None:
        return {}
    return json.loads(raw)


# ── LLM Cost Metrics ─────────────────────────────────────────────────────────

@app.get("/metrics/llm")
async def llm_metrics() -> dict:
    """Aggregated LLM call counts and cost estimates from kernel."""
    r = await _get_pub()
    raw = await r.get(_LLM_COST_KEY)
    if raw is None:
        return {}
    return json.loads(raw)


# ── Timeline ──────────────────────────────────────────────────────────────────

@app.get("/timeline")
async def timeline(limit: int = 200) -> list:
    """Recent events in chronological order for the Company Timeline view."""
    events = list(_recent)
    filtered = [
        e for e in events
        if e.get("topic") not in ("PING", "HEALTH_TICK")
    ]
    return filtered[-limit:]


# ── Agent Registry ────────────────────────────────────────────────────────────

@app.get("/registry")
async def registry() -> dict:
    """Live agent registry info — derived from recent events."""
    hired: dict[str, dict] = {}
    fired: set[str] = set()

    for e in _recent:
        topic = e.get("topic", "")
        d     = e.get("data", {})
        if topic == "AGENT_HIRED":
            role = str(d.get("role", ""))
            if role:
                hired[role] = {
                    "role":     role,
                    "division": str(d.get("division", "executive_board")),
                    "hired_at": e.get("ts", ""),
                    "online":   True,
                }
        elif topic == "AGENT_FIRED":
            role = str(d.get("role", ""))
            if role:
                fired.add(role)

    # Mark fired agents
    for role in fired:
        if role in hired:
            hired[role]["online"] = False

    # Attach LLM cost per agent
    r   = await _get_pub()
    raw = await r.get(_LLM_COST_KEY)
    cost_data = json.loads(raw) if raw else {}
    agent_costs = cost_data.get("agents", {})
    for role, info in hired.items():
        ac = agent_costs.get(role, {})
        info["llm_calls"]   = ac.get("calls",    0)
        info["llm_cost_usd"] = ac.get("cost_usd", 0.0)

    return {"agents": list(hired.values()), "total": len(hired)}


# ── Trade History (paginated) ─────────────────────────────────────────────────

def _row_to_dict(r) -> dict:
    """Convert asyncpg Record to a JSON-serializable dict."""
    d = dict(r)
    for k, v in d.items():
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
        elif hasattr(v, "__float__"):
            try:
                d[k] = float(v)
            except Exception:
                pass
    return d


@app.get("/trades")
async def trades_history(limit: int = 200, offset: int = 0, status: str = "all") -> list:
    """All trade decisions. status=open|closed|all."""
    pool = await _ensure_pg()
    if pool is None:
        return []
    if status == "open":
        where = "WHERE outcome = 'APPROVED' AND trade_result IS NULL"
    elif status == "closed":
        where = "WHERE trade_result IS NOT NULL"
    else:
        where = ""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT * FROM trade_decisions {where} ORDER BY created_at DESC LIMIT $1 OFFSET $2",
            limit, offset,
        )
    return [_row_to_dict(r) for r in rows]


@app.get("/trades/export.csv")
async def export_trades_csv():
    """Download all closed trades as CSV."""
    import csv, io  # noqa: PLC0415
    from fastapi.responses import StreamingResponse  # noqa: PLC0415
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(status_code=503, detail="DB not available")
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, symbol, direction, price AS entry_price, fill_price,
                      exit_price, lots, pnl_usd, trade_result, risk_usd,
                      confidence, reason, created_at, exit_at
               FROM trade_decisions
               WHERE trade_result IS NOT NULL
               ORDER BY created_at ASC"""
        )
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "symbol", "direction", "entry_price", "fill_price",
                     "exit_price", "lots", "pnl_usd", "trade_result", "risk_usd",
                     "confidence", "reason", "created_at", "exit_at"])
    for r in rows:
        writer.writerow([
            r["id"], r["symbol"], r["direction"],
            r["entry_price"], r["fill_price"], r["exit_price"],
            r["lots"], r["pnl_usd"], r["trade_result"], r["risk_usd"],
            r["confidence"], r["reason"], r["created_at"], r["exit_at"],
        ])
    buf.seek(0)
    filename = f"polis_trades_{datetime.now(timezone.utc).strftime('%Y%m%d')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.post("/trades/{trade_id}/close")
async def close_trade_manual(trade_id: int, request: Request) -> dict:
    """Manually close an open trade with a specified exit price."""
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(status_code=503, detail="DB not available")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Body must be valid JSON")

    exit_price = float(body.get("exit_price", 0))
    if exit_price <= 0:
        raise HTTPException(status_code=400, detail="exit_price must be > 0")

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT id, symbol, direction, price, lots
               FROM trade_decisions
               WHERE id = $1 AND outcome = 'APPROVED' AND trade_result IS NULL""",
            trade_id,
        )

    if not row:
        raise HTTPException(status_code=404, detail="Trade not found or already closed")

    symbol    = row["symbol"]
    direction = row["direction"]
    entry     = float(row["price"] or 0)
    lots      = float(row["lots"]  or 0)
    units     = _UNITS_PER_LOT.get(symbol, 100)

    pnl    = round((exit_price - entry if direction == "long" else entry - exit_price) * lots * units, 2)
    result = "WIN" if pnl >= 0 else "LOSS"

    async with pool.acquire() as conn:
        await conn.execute(
            """UPDATE trade_decisions
               SET exit_price=$1, exit_at=NOW(), pnl_usd=$2, trade_result=$3
               WHERE id=$4""",
            exit_price, pnl, result, trade_id,
        )

    r = await _get_pub()
    await r.publish("TRADE_CLOSED", json.dumps({
        "id":         trade_id,
        "symbol":     symbol,
        "direction":  direction,
        "entry":      entry,
        "exit_price": exit_price,
        "pnl_usd":    pnl,
        "result":     result,
        "lots":       lots,
        "manual":     True,
    }))
    log.info("Manual close trade #%d %s %s  entry=%s exit=%s  P&L=$%.2f [%s]",
             trade_id, direction.upper(), symbol, entry, exit_price, pnl, result)
    return {"status": "closed", "trade_id": trade_id, "pnl_usd": pnl, "result": result}


@app.get("/equity")
async def equity_curve() -> list:
    """Cumulative P&L time-series for the equity curve chart."""
    pool = await _ensure_pg()
    if pool is None:
        return []
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT exit_at AS ts, pnl_usd, trade_result, symbol, direction
               FROM trade_decisions
               WHERE trade_result IS NOT NULL AND pnl_usd IS NOT NULL
               ORDER BY exit_at ASC NULLS LAST"""
        )
    cum = 0.0
    result = []
    for r in rows:
        pnl = float(r["pnl_usd"])
        cum = round(cum + pnl, 2)
        result.append({
            "ts":           r["ts"].isoformat() if r["ts"] else None,
            "pnl":          round(pnl, 2),
            "cum_pnl":      cum,
            "trade_result": r["trade_result"],
            "symbol":       r["symbol"],
            "direction":    r["direction"],
        })
    return result


# ── Settings ──────────────────────────────────────────────────────────────────

_SETTINGS_KEY = "polis:settings"
_SETTINGS_DEFAULTS: dict = {
    "min_confidence":     60,
    "atr_ratio":          2.0,
    "trading_hours_start": 7,
    "trading_hours_end":   20,
    "board_interval_s":   300,
}


@app.get("/settings")
async def get_settings() -> dict:
    r = await _get_pub()
    raw = await r.hgetall(_SETTINGS_KEY)
    saved = {k.decode(): float(v) for k, v in raw.items()} if raw else {}
    result: dict = {**_SETTINGS_DEFAULTS, **saved}
    # Merge live control state
    paused   = await r.hget(_CONTROL_KEY, "paused")
    max_risk = await r.hget(_CONTROL_KEY, "max_risk")
    result["paused"]        = paused == b"1"
    result["max_risk"]      = float(max_risk or 0.005)
    result["signal_source"] = os.getenv("SIGNAL_SOURCE", "mock")
    result["oanda_live"]    = os.getenv("OANDA_ENABLED", "false").lower() == "true"
    return result


@app.post("/settings")
async def post_settings(request: Request) -> dict:
    body = await request.json()
    r    = await _get_pub()
    updated: dict = {}

    if "min_confidence" in body:
        val = int(max(40, min(95, int(body["min_confidence"]))))
        await r.hset(_SETTINGS_KEY, "min_confidence", val)
        updated["min_confidence"] = val
    if "atr_ratio" in body:
        val = round(float(max(1.0, min(10.0, float(body["atr_ratio"])))), 2)
        await r.hset(_SETTINGS_KEY, "atr_ratio", val)
        updated["atr_ratio"] = val
    if "trading_hours_start" in body:
        val = int(max(0, min(23, int(body["trading_hours_start"]))))
        await r.hset(_SETTINGS_KEY, "trading_hours_start", val)
        updated["trading_hours_start"] = val
    if "trading_hours_end" in body:
        val = int(max(0, min(23, int(body["trading_hours_end"]))))
        await r.hset(_SETTINGS_KEY, "trading_hours_end", val)
        updated["trading_hours_end"] = val
    if "board_interval_s" in body:
        val = int(max(60, min(3600, int(body["board_interval_s"]))))
        await r.hset(_SETTINGS_KEY, "board_interval_s", val)
        updated["board_interval_s"] = val

    # max_risk goes through existing control channel (kernel handles it live)
    if "max_risk" in body:
        value = round(float(max(0.002, min(0.010, float(body["max_risk"])))), 4)
        await r.hset(_CONTROL_KEY, "max_risk", str(value))
        await r.publish("RISK_OVERRIDE", json.dumps({
            "max_risk": value,
            "ts": datetime.now(timezone.utc).isoformat(),
        }))
        updated["max_risk"] = value

    if updated:
        await r.publish("SETTINGS_UPDATE", json.dumps({
            "ts": datetime.now(timezone.utc).isoformat(),
            **updated,
        }))

    return {"status": "ok", "updated": updated}


_ACTIVE_SYMBOLS_KEY = "polis:active_symbols"
_ALL_SYMBOLS        = ["XAUUSD", "EURUSD", "GBPUSD", "BTCUSD", "XAGUSD"]


@app.get("/settings/symbols")
async def get_active_symbols() -> dict:
    """Return {XAUUSD: true, EURUSD: true, ...} for all known symbols."""
    r   = await _get_pub()
    raw = await r.get(_ACTIVE_SYMBOLS_KEY)
    saved: dict[str, bool] = json.loads(raw) if raw else {}
    # Default: active if listed in SIGNAL_SYMBOLS env, inactive otherwise
    env_syms = {
        s.strip().replace("/", "")
        for s in os.getenv("SIGNAL_SYMBOLS", "XAU/USD,EUR/USD,BTC/USD").split(",")
        if s.strip()
    }
    return {sym: saved.get(sym, sym in env_syms) for sym in _ALL_SYMBOLS}


@app.post("/settings/symbols")
async def set_active_symbols(request: Request) -> dict:
    """Accept {XAUUSD: true, BTCUSD: false} — saves to Redis."""
    body: dict[str, bool] = await request.json()
    r    = await _get_pub()
    # Merge with current state
    raw  = await r.get(_ACTIVE_SYMBOLS_KEY)
    current: dict[str, bool] = json.loads(raw) if raw else {}
    for sym, active in body.items():
        if sym in _ALL_SYMBOLS:
            current[sym] = bool(active)
    await r.set(_ACTIVE_SYMBOLS_KEY, json.dumps(current))
    log.info("Symbol config updated: %s", current)
    return {"status": "ok", "active_symbols": current}


# ── Notification status & test ────────────────────────────────────────────────

_TG_TOKEN  = os.getenv("TELEGRAM_BOT_TOKEN", "")
_TG_CHAT   = os.getenv("TELEGRAM_CHAT_ID",   "")
_DISCORD_URL = os.getenv("DISCORD_WEBHOOK_URL", "")


@app.get("/notify/status")
async def notify_status() -> dict:
    return {
        "telegram": {
            "configured": bool(_TG_TOKEN and _TG_CHAT),
            "has_token":   bool(_TG_TOKEN),
            "has_chat_id": bool(_TG_CHAT),
        },
        "discord": {
            "configured": bool(_DISCORD_URL),
        },
    }


@app.post("/notify/test")
async def notify_test() -> dict:
    import httpx as _httpx
    results: dict[str, str] = {}

    if _TG_TOKEN and _TG_CHAT:
        try:
            async with _httpx.AsyncClient() as client:
                r = await client.post(
                    f"https://api.telegram.org/bot{_TG_TOKEN}/sendMessage",
                    json={
                        "chat_id":    _TG_CHAT,
                        "text":       "🟢 <b>POLIS — Notification Test</b>\n\nSystem online. All channels working.",
                        "parse_mode": "HTML",
                    },
                    timeout=10.0,
                )
            results["telegram"] = "ok" if r.status_code == 200 else f"error {r.status_code}"
        except Exception as exc:
            results["telegram"] = f"error: {exc}"
    else:
        results["telegram"] = "not configured"

    if _DISCORD_URL:
        try:
            async with _httpx.AsyncClient() as client:
                r = await client.post(
                    _DISCORD_URL,
                    json={"embeds": [{
                        "title":       "🟢  POLIS — Notification Test",
                        "description": "System online. All channels working.",
                        "color":       0x10b981,
                        "footer":      {"text": "POLIS Gateway"},
                    }]},
                    timeout=10.0,
                )
            results["discord"] = "ok" if r.status_code in (200, 204) else f"error {r.status_code}"
        except Exception as exc:
            results["discord"] = f"error: {exc}"
    else:
        results["discord"] = "not configured"

    return results


# ── Circuit Breaker ───────────────────────────────────────────────────────────

_CB_KEY = "polis:circuit_breaker"


@app.get("/circuit-breaker")
async def circuit_breaker_status() -> dict:
    """Live Circuit Breaker state — reads from kernel Redis writes."""
    r = await _get_pub()
    raw = await r.hgetall(_CB_KEY)
    if not raw:
        return {
            "triggered":    False,
            "reason":       "",
            "consec":       0,
            "day_notional": 0.0,
            "daily_budget": float(os.getenv("DAILY_BUDGET_USD", "620")),
            "max_consec":   int(os.getenv("CB_MAX_CONSECUTIVE_REJECTS", "5")),
            "triggered_at": None,
        }
    return {
        "triggered":    raw.get(b"triggered", b"0") == b"1",
        "reason":       raw.get(b"reason", b"").decode(),
        "consec":       int(raw.get(b"consec", b"0")),
        "day_notional": float(raw.get(b"day_notional", b"0")),
        "daily_budget": float(raw.get(b"daily_budget", b"620")),
        "max_consec":   int(raw.get(b"max_consec", b"5")),
        "triggered_at": raw.get(b"triggered_at", b"").decode() or None,
    }


# ── Daily Briefing ────────────────────────────────────────────────────────────

@app.get("/briefing")
async def briefing_today() -> dict:
    """Today's trade summary for the dashboard briefing card."""
    pool = await _ensure_pg()
    if pool is None:
        return {}
    async with pool.acquire() as conn:
        trade_row = await conn.fetchrow(
            """SELECT
                COUNT(*)                                              AS total,
                COUNT(*) FILTER (WHERE outcome='APPROVED')           AS approved,
                COUNT(*) FILTER (WHERE outcome='BLOCKED')            AS blocked,
                COUNT(*) FILTER (WHERE trade_result='WIN')           AS wins,
                COUNT(*) FILTER (WHERE trade_result='LOSS')          AS losses,
                COALESCE(SUM(pnl_usd) FILTER
                    (WHERE trade_result IS NOT NULL), 0)              AS total_pnl,
                ROUND(AVG(confidence) FILTER
                    (WHERE confidence IS NOT NULL), 1)               AS avg_confidence,
                MAX(confidence) FILTER (WHERE confidence IS NOT NULL) AS max_confidence,
                COALESCE(SUM(lots * CASE symbol
                    WHEN 'XAUUSD' THEN 100
                    WHEN 'EURUSD' THEN 100000
                    WHEN 'GBPUSD' THEN 100000
                    WHEN 'BTCUSD' THEN 1
                    WHEN 'XAGUSD' THEN 5000
                    ELSE 100 END * price)
                    FILTER (WHERE outcome='APPROVED'), 0)            AS total_notional
               FROM trade_decisions
               WHERE (created_at AT TIME ZONE 'Asia/Bangkok')::date
                   = (NOW() AT TIME ZONE 'Asia/Bangkok')::date"""
        )
        board_rows = await conn.fetch(
            """SELECT resolution, COUNT(*) AS cnt
               FROM board_resolutions
               WHERE (created_at AT TIME ZONE 'Asia/Bangkok')::date
                   = (NOW() AT TIME ZONE 'Asia/Bangkok')::date
               GROUP BY resolution"""
        )
        sym_rows = await conn.fetch(
            """SELECT symbol,
                COUNT(*)                                    AS total,
                COUNT(*) FILTER (WHERE outcome='APPROVED') AS approved,
                COUNT(*) FILTER (WHERE outcome='BLOCKED')  AS blocked
               FROM trade_decisions
               WHERE (created_at AT TIME ZONE 'Asia/Bangkok')::date
                   = (NOW() AT TIME ZONE 'Asia/Bangkok')::date
               GROUP BY symbol ORDER BY total DESC"""
        )
        yesterday_row = await conn.fetchrow(
            """SELECT
                COUNT(*)                                              AS total,
                COUNT(*) FILTER (WHERE outcome='APPROVED')           AS approved,
                COALESCE(SUM(pnl_usd) FILTER
                    (WHERE trade_result IS NOT NULL), 0)              AS total_pnl,
                COUNT(*) FILTER (WHERE trade_result='WIN')           AS wins
               FROM trade_decisions
               WHERE (created_at AT TIME ZONE 'Asia/Bangkok')::date
                   = (NOW() AT TIME ZONE 'Asia/Bangkok')::date - 1"""
        )

    total    = int(trade_row["total"] or 0)
    approved = int(trade_row["approved"] or 0)
    wins     = int(trade_row["wins"] or 0)
    board    = {r["resolution"]: int(r["cnt"]) for r in board_rows}

    yt = dict(yesterday_row)
    return {
        "today": {
            "total":          total,
            "approved":       approved,
            "blocked":        int(trade_row["blocked"] or 0),
            "wins":           wins,
            "losses":         int(trade_row["losses"] or 0),
            "approval_rate":  round(approved / total * 100, 1) if total else 0.0,
            "win_rate":       round(wins / approved * 100, 1) if approved else 0.0,
            "total_pnl":      float(trade_row["total_pnl"] or 0),
            "avg_confidence": float(trade_row["avg_confidence"] or 0),
            "max_confidence": int(trade_row["max_confidence"] or 0),
            "total_notional": float(trade_row["total_notional"] or 0),
            "board":      board,
            "by_symbol":  {
                r["symbol"]: {
                    "total":    int(r["total"]),
                    "approved": int(r["approved"]),
                    "blocked":  int(r["blocked"]),
                }
                for r in sym_rows
            },
        },
        "yesterday": {
            "total":    int(yt.get("total") or 0),
            "approved": int(yt.get("approved") or 0),
            "wins":     int(yt.get("wins") or 0),
            "total_pnl": float(yt.get("total_pnl") or 0),
        },
        "broker": {
            "mode":     os.getenv("OANDA_ENV", "practice"),
            "live":     os.getenv("OANDA_ENABLED", "false").lower() == "true",
            "signal":   os.getenv("SIGNAL_SOURCE", "mock"),
        },
    }


# ── Analytics ─────────────────────────────────────────────────────────────────

@app.get("/analytics")
async def analytics() -> dict:
    """Aggregated P&L analytics for Finance page: overall, daily, symbols, monthly."""
    pool = await _ensure_pg()
    if pool is None:
        return {}
    async with pool.acquire() as conn:
        overall = await conn.fetchrow(
            """SELECT
                COUNT(*) FILTER (WHERE trade_result IS NOT NULL)           AS total_closed,
                COUNT(*) FILTER (WHERE trade_result = 'WIN')               AS wins,
                COUNT(*) FILTER (WHERE trade_result = 'LOSS')              AS losses,
                COALESCE(SUM(pnl_usd) FILTER
                    (WHERE trade_result IS NOT NULL), 0)                   AS total_pnl,
                COALESCE(MAX(pnl_usd) FILTER
                    (WHERE trade_result IS NOT NULL), 0)                   AS best_trade,
                COALESCE(MIN(pnl_usd) FILTER
                    (WHERE trade_result IS NOT NULL), 0)                   AS worst_trade
               FROM trade_decisions"""
        )
        daily_rows = await conn.fetch(
            """SELECT
                (exit_at AT TIME ZONE 'Asia/Bangkok')::date             AS day,
                COALESCE(SUM(pnl_usd), 0)                               AS day_pnl,
                COUNT(*)                                                 AS trades,
                COUNT(*) FILTER (WHERE trade_result = 'WIN')             AS wins
               FROM trade_decisions
               WHERE trade_result IS NOT NULL
                 AND pnl_usd IS NOT NULL
                 AND exit_at >= NOW() - INTERVAL '365 days'
               GROUP BY day
               ORDER BY day"""
        )
        best_worst = await conn.fetchrow(
            """SELECT MAX(s.day_pnl) AS best_day, MIN(s.day_pnl) AS worst_day
               FROM (
                   SELECT (exit_at AT TIME ZONE 'Asia/Bangkok')::date AS d,
                          SUM(pnl_usd) AS day_pnl
                   FROM trade_decisions
                   WHERE trade_result IS NOT NULL AND pnl_usd IS NOT NULL
                   GROUP BY d
               ) s"""
        )
        symbol_rows = await conn.fetch(
            """SELECT
                symbol,
                COUNT(*) FILTER (WHERE trade_result IS NOT NULL)         AS total,
                COUNT(*) FILTER (WHERE trade_result = 'WIN')             AS wins,
                COALESCE(SUM(pnl_usd) FILTER
                    (WHERE trade_result IS NOT NULL), 0)                 AS pnl,
                COALESCE(SUM(risk_usd)  FILTER
                    (WHERE outcome = 'APPROVED'), 0)                     AS total_risk_usd,
                COALESCE(AVG(risk_usd)  FILTER
                    (WHERE outcome = 'APPROVED' AND risk_usd IS NOT NULL), 0) AS avg_risk_usd
               FROM trade_decisions
               WHERE trade_result IS NOT NULL
               GROUP BY symbol
               ORDER BY total DESC"""
        )
        monthly_rows = await conn.fetch(
            """SELECT
                TO_CHAR(DATE_TRUNC('month',
                    exit_at AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM')     AS month,
                COUNT(*) FILTER (WHERE trade_result IS NOT NULL)         AS total,
                COUNT(*) FILTER (WHERE trade_result = 'WIN')             AS wins,
                COALESCE(SUM(pnl_usd) FILTER
                    (WHERE trade_result IS NOT NULL), 0)                 AS pnl
               FROM trade_decisions
               WHERE trade_result IS NOT NULL AND pnl_usd IS NOT NULL
               GROUP BY month
               ORDER BY month DESC
               LIMIT 12"""
        )

    tc = int(overall["total_closed"] or 0)
    w  = int(overall["wins"] or 0)
    return {
        "overall": {
            "total_closed": tc,
            "wins":         w,
            "losses":       int(overall["losses"] or 0),
            "total_pnl":    float(overall["total_pnl"] or 0),
            "win_rate":     round(w / tc * 100, 1) if tc else 0.0,
            "best_trade":   float(overall["best_trade"] or 0),
            "worst_trade":  float(overall["worst_trade"] or 0),
        },
        "best_day":  float(best_worst["best_day"]  or 0) if best_worst else 0.0,
        "worst_day": float(best_worst["worst_day"] or 0) if best_worst else 0.0,
        "daily": [
            {
                "day":    str(r["day"]),
                "pnl":    float(r["day_pnl"]),
                "trades": int(r["trades"]),
                "wins":   int(r["wins"]),
            }
            for r in daily_rows
        ],
        "symbols": [
            {
                "symbol":        r["symbol"],
                "total":         int(r["total"]),
                "wins":          int(r["wins"]),
                "pnl":           float(r["pnl"]),
                "win_rate":      round(int(r["wins"]) / int(r["total"]) * 100, 1) if int(r["total"]) else 0.0,
                "total_risk_usd": round(float(r["total_risk_usd"]), 2),
                "avg_risk_usd":   round(float(r["avg_risk_usd"]), 2),
            }
            for r in symbol_rows
        ],
        "monthly": [
            {
                "month":    r["month"],
                "total":    int(r["total"]),
                "wins":     int(r["wins"]),
                "pnl":      float(r["pnl"]),
                "win_rate": round(int(r["wins"]) / int(r["total"]) * 100, 1) if int(r["total"]) else 0.0,
            }
            for r in monthly_rows
        ],
    }



# ── Content Queue ─────────────────────────────────────────────────────────────

import uuid as _uuid


def _queue_row(r) -> dict:
    return {
        **dict(r),
        "platforms":      r["platforms"]       if isinstance(r["platforms"], list)       else json.loads(r["platforms"]       or "[]"),
        "hashtags":       r["hashtags"]        if isinstance(r["hashtags"],  list)       else json.loads(r["hashtags"]        or "[]"),
        "published_urls": r["published_urls"]  if isinstance(r["published_urls"], dict)  else json.loads(r["published_urls"]  or "{}"),
        "metadata":       r["metadata"]        if isinstance(r["metadata"],   dict)      else json.loads(r["metadata"]        or "{}"),
        "scheduled_at":   r["scheduled_at"].isoformat() if r["scheduled_at"] else None,
        "created_at":     r["created_at"].isoformat()   if r["created_at"]   else None,
    }


@app.get("/social/queue")
async def list_queue(status: str = "") -> list:
    pool = await _ensure_pg()
    if pool is None:
        return []
    where = "WHERE status = $1" if status else ""
    params = [status] if status else []
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT * FROM content_queue {where} ORDER BY created_at DESC LIMIT 100",
            *params,
        )
    return [_queue_row(r) for r in rows]


@app.post("/social/queue")
async def add_to_queue(request: Request) -> dict:
    """Add content to the publishing queue. Used by Media Studio, Trading, or manually."""
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(503, "DB unavailable")
    body = await request.json()
    item_id = str(_uuid.uuid4())
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO content_queue
               (id, source, type, platforms, title, caption, hashtags,
                asset_url, thumbnail_url, scheduled_at, metadata)
               VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)""",
            item_id,
            body.get("source", "manual"),
            body.get("type", "text"),
            json.dumps(body.get("platforms", [])),
            body.get("title"),
            body.get("caption"),
            json.dumps(body.get("hashtags", [])),
            body.get("asset_url"),
            body.get("thumbnail_url"),
            body.get("scheduled_at"),
            json.dumps(body.get("metadata", {})),
        )
    log.info("Content queue: added %s [%s] from %s", item_id, body.get("type"), body.get("source"))
    pool2 = await _ensure_pg()
    async with pool2.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM content_queue WHERE id=$1", item_id)
    return _queue_row(row)


@app.patch("/social/queue/{item_id}")
async def update_queue_item(item_id: str, request: Request) -> dict:
    """Update caption, platforms, scheduled_at, or status."""
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(503, "DB unavailable")
    body = await request.json()
    allowed = {"caption", "title", "hashtags", "platforms", "scheduled_at", "status", "asset_url"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(400, "No updatable fields")

    set_parts = []
    vals: list = []
    for i, (k, v) in enumerate(updates.items(), 1):
        if k in ("hashtags", "platforms"):
            set_parts.append(f"{k} = ${i}::jsonb")
            vals.append(json.dumps(v))
        else:
            set_parts.append(f"{k} = ${i}")
            vals.append(v)
    vals.append(item_id)

    async with pool.acquire() as conn:
        await conn.execute(
            f"UPDATE content_queue SET {', '.join(set_parts)} WHERE id = ${len(vals)}",
            *vals,
        )
        row = await conn.fetchrow("SELECT * FROM content_queue WHERE id=$1", item_id)
    if not row:
        raise HTTPException(404, "Item not found")
    return _queue_row(row)


@app.delete("/social/queue/{item_id}")
async def delete_queue_item(item_id: str) -> dict:
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(503, "DB unavailable")
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM content_queue WHERE id=$1", item_id)
    return {"deleted": item_id}


@app.post("/social/queue/{item_id}/publish")
async def publish_queue_item(item_id: str) -> dict:
    """Actually post content to platforms. Single source of truth for all publishing."""
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(503, "DB unavailable")
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM content_queue WHERE id=$1", item_id)
    if not row:
        raise HTTPException(404, "Item not found")

    item = _queue_row(row)
    platforms = item["platforms"]
    results: dict[str, dict] = {}

    # Mark as publishing
    async with pool.acquire() as conn:
        await conn.execute("UPDATE content_queue SET status='publishing' WHERE id=$1", item_id)

    import httpx as _httpx  # noqa: PLC0415

    for platform in platforms:
        if platform == "youtube" and item.get("asset_url"):
            # Delegate to media service for YouTube upload
            media_url = os.getenv("MEDIA_SERVICE_URL", "http://media:8001")
            try:
                async with _httpx.AsyncClient(timeout=300.0) as client:
                    r = await client.post(f"{media_url}/publish", json={
                        "episode_id": item["metadata"].get("episode_id", ""),
                        "platforms": ["youtube"],
                        "title": item.get("title", ""),
                        "description": item.get("caption", ""),
                        "tags": item.get("hashtags", []),
                    })
                    yt_result = r.json().get("results", {}).get("youtube", {})
                    results["youtube"] = yt_result
            except Exception as exc:
                results["youtube"] = {"error": str(exc)}
        else:
            # For text-only or non-configured platforms: mark ready for manual post
            results[platform] = {
                "status":   "ready",
                "message":  f"Copy caption and post to {platform}",
                "copy_url": item.get("asset_url"),
            }

    # Update published_urls and status
    published_urls = {p: r.get("url", "") for p, r in results.items() if r.get("url")}
    new_status = "published" if any(r.get("url") for r in results.values()) else "queued"
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE content_queue SET status=$1, published_urls=$2::jsonb WHERE id=$3",
            new_status, json.dumps(published_urls), item_id,
        )

    return {"item_id": item_id, "results": results}


@app.get("/social/queue/{item_id}/analytics")
async def get_content_analytics(item_id: str) -> dict:
    """Fetch real-time analytics for a published item (YouTube views/likes)."""
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(503, "DB unavailable")
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM content_queue WHERE id=$1", item_id)
    if not row:
        raise HTTPException(404, "Item not found")

    item = _queue_row(row)
    published = item.get("published_urls", {})
    analytics: dict[str, dict] = {}

    # YouTube analytics (if posted and token available)
    yt_url = published.get("youtube")
    if yt_url and os.getenv("YOUTUBE_TOKEN_JSON"):
        try:
            video_id = yt_url.split("/")[-1]
            from googleapiclient.discovery import build as _yt_build  # noqa: PLC0415
            from google.oauth2.credentials import Credentials  # noqa: PLC0415
            creds = Credentials.from_authorized_user_info(
                json.loads(os.getenv("YOUTUBE_TOKEN_JSON", "{}"))
            )
            youtube = _yt_build("youtube", "v3", credentials=creds)
            resp = youtube.videos().list(
                part="statistics", id=video_id
            ).execute()
            if resp.get("items"):
                stats = resp["items"][0]["statistics"]
                analytics["youtube"] = {
                    "views":    int(stats.get("viewCount",    0)),
                    "likes":    int(stats.get("likeCount",    0)),
                    "comments": int(stats.get("commentCount", 0)),
                    "url":      yt_url,
                }
        except Exception as exc:
            analytics["youtube"] = {"error": str(exc), "url": yt_url}
    elif yt_url:
        analytics["youtube"] = {"url": yt_url, "note": "ตั้งค่า YOUTUBE_TOKEN_JSON เพื่อดู analytics"}

    # Placeholder for other platforms (APIs need business account approval)
    for platform, url in published.items():
        if platform != "youtube" and url:
            analytics[platform] = {"url": url, "note": "ดู analytics บน platform โดยตรง"}

    return {"item_id": item_id, "analytics": analytics, "platforms": list(published.keys())}


# ── Signal Service ────────────────────────────────────────────────────────────

@app.get("/signals/subscribers")
async def list_subscribers() -> list:
    pool = await _ensure_pg()
    if pool is None:
        return []
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM signal_subscribers ORDER BY created_at DESC"
        )
    return [dict(r) | {"expires_at": r["expires_at"].isoformat() if r["expires_at"] else None,
                       "created_at": r["created_at"].isoformat()}
            for r in rows]


@app.post("/signals/subscribers")
async def add_subscriber(request: Request) -> dict:
    """Add a paid subscriber manually."""
    body   = await request.json()
    pool   = await _ensure_pg()
    if pool is None:
        raise HTTPException(503, "DB unavailable")
    from datetime import timedelta  # noqa: PLC0415
    expires = (datetime.now(timezone.utc) + timedelta(days=body.get("days", 30))).isoformat()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO signal_subscribers
               (telegram_id, username, plan, status, expires_at, paid_amount, notes)
               VALUES ($1,$2,$3,'active',$4,$5,$6)
               ON CONFLICT (telegram_id) DO UPDATE
               SET status='active', expires_at=$4, paid_amount=paid_amount+$5, notes=$6
               RETURNING *""",
            int(body["telegram_id"]),
            body.get("username", ""),
            body.get("plan", "monthly"),
            expires,
            float(body.get("paid_amount", 0)),
            body.get("notes", ""),
        )
    log.info("Subscriber added: @%s (TG:%s) expires %s",
             body.get("username"), body["telegram_id"], expires[:10])
    return dict(row) | {"expires_at": row["expires_at"].isoformat()}


@app.delete("/signals/subscribers/{telegram_id}")
async def remove_subscriber(telegram_id: int) -> dict:
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(503, "DB unavailable")
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE signal_subscribers SET status='cancelled' WHERE telegram_id=$1",
            telegram_id,
        )
    return {"status": "cancelled", "telegram_id": telegram_id}


@app.post("/signals/expire-subscribers")
async def expire_subscribers() -> dict:
    """Mark subscribers whose expires_at has passed as expired."""
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(status_code=503, detail="DB unavailable")
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """UPDATE signal_subscribers
               SET status='expired'
               WHERE status='active' AND expires_at < NOW()
               RETURNING username, telegram_id"""
        )
    expired = [dict(r) for r in rows]
    if expired:
        try:
            pub = await _get_pub()
            await pub.publish("SUBSCRIBERS_EXPIRED", json.dumps({"expired": expired}))
        except Exception:
            pass
    return {"expired_count": len(expired), "expired": expired}


@app.get("/signals/stats")
async def signal_stats() -> dict:
    pool = await _ensure_pg()
    if pool is None:
        return {}
    async with pool.acquire() as conn:
        subs = await conn.fetchrow(
            """SELECT
                COUNT(*) FILTER (WHERE status='active') AS active,
                COUNT(*) FILTER (WHERE status='cancelled') AS cancelled,
                COALESCE(SUM(paid_amount) FILTER (WHERE status='active'), 0) AS mrr
               FROM signal_subscribers"""
        )
        trades = await conn.fetchrow(
            """SELECT
                COUNT(*) FILTER (WHERE outcome='APPROVED') AS total_signals,
                COUNT(*) FILTER (WHERE trade_result='WIN') AS wins,
                COUNT(*) FILTER (WHERE trade_result='LOSS') AS losses,
                COALESCE(SUM(pnl_usd) FILTER (WHERE trade_result IS NOT NULL), 0) AS total_pnl,
                ROUND(AVG(confidence) FILTER (WHERE confidence IS NOT NULL),1) AS avg_confidence
               FROM trade_decisions"""
        )
        broadcasts = await conn.fetchval(
            "SELECT COUNT(*) FROM signal_broadcasts"
        )
    return {
        "subscribers": {
            "active":    int(subs["active"] or 0),
            "cancelled": int(subs["cancelled"] or 0),
            "mrr":       float(subs["mrr"] or 0),
        },
        "performance": {
            "total_signals": int(trades["total_signals"] or 0),
            "wins":          int(trades["wins"] or 0),
            "losses":        int(trades["losses"] or 0),
            "win_rate":      round(int(trades["wins"] or 0) / max(int(trades["wins"] or 0) + int(trades["losses"] or 0), 1) * 100, 1),
            "total_pnl":     float(trades["total_pnl"] or 0),
            "avg_confidence": float(trades["avg_confidence"] or 0),
        },
        "broadcasts_sent": int(broadcasts or 0),
    }


@app.get("/signals/broadcasts")
async def list_broadcasts(limit: int = 20) -> list:
    pool = await _ensure_pg()
    if pool is None:
        return []
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM signal_broadcasts ORDER BY created_at DESC LIMIT $1", limit
        )
    return [dict(r) | {"created_at": r["created_at"].isoformat()} for r in rows]


# ── PromptPay QR + Subscription Requests ─────────────────────────────────────

_PROMPTPAY_NUMBER  = os.getenv("PROMPTPAY_NUMBER", "")
_MONTHLY_THB       = float(os.getenv("SIGNAL_MONTHLY_THB", "500"))
_CHANNEL_INVITE    = os.getenv("CHANNEL_INVITE_LINK", "")

_PLANS = {
    "monthly":   {"label": "รายเดือน",   "days": 30,  "thb": _MONTHLY_THB,       "save": ""},
    "quarterly": {"label": "รายไตรมาส",  "days": 90,  "thb": _MONTHLY_THB * 2.5, "save": "ประหยัด 17%"},
    "annual":    {"label": "รายปี",       "days": 365, "thb": _MONTHLY_THB * 9,   "save": "ประหยัด 25%"},
}


def _promptpay_payload(phone: str, amount: float | None = None) -> str:
    """Generate EMVCo PromptPay QR payload."""
    def tlv(tag: str, val: str) -> str:
        return f"{tag}{len(val):02d}{val}"

    def crc16(data: str) -> str:
        crc = 0xFFFF
        for c in data:
            crc ^= ord(c) << 8
            for _ in range(8):
                crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else crc << 1
        return f"{crc & 0xFFFF:04X}"

    proxy = "0066" + phone.lstrip("0")
    acct  = tlv("00", "A000000677010111") + tlv("01", "01") + tlv("02", proxy)
    body  = (
        tlv("00", "01") +
        tlv("01", "12") +
        tlv("29", acct) +
        tlv("53", "764") +
        (tlv("54", f"{amount:.2f}") if amount is not None else "") +
        tlv("58", "TH") +
        "6304"
    )
    return body + crc16(body)


@app.get("/signals/qr/{plan}")
async def promptpay_qr(plan: str):
    """Return PromptPay QR as base64 PNG for a given plan."""
    import base64, io  # noqa: PLC0415
    try:
        import qrcode  # noqa: PLC0415
    except ImportError:
        raise HTTPException(status_code=503, detail="qrcode not installed")

    if not _PROMPTPAY_NUMBER:
        raise HTTPException(status_code=503, detail="PROMPTPAY_NUMBER not configured")

    info   = _PLANS.get(plan, _PLANS["monthly"])
    amount = float(info["thb"])
    data   = _promptpay_payload(_PROMPTPAY_NUMBER, amount)

    qr  = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=8, border=2)
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return {"qr_b64": b64, "amount": amount, "plan": plan, "label": info["label"]}


@app.get("/signals/plans")
async def get_plans() -> dict:
    return _PLANS


@app.post("/signals/subscribe-request")
async def create_subscribe_request(request: Request) -> dict:
    """Customer submits a subscription request after paying PromptPay."""
    body = await request.json()
    username   = str(body.get("username", "")).lstrip("@").strip()
    plan       = str(body.get("plan", "monthly"))
    slip_note  = str(body.get("slip_note", ""))
    telegram_id = body.get("telegram_id")

    if not username:
        raise HTTPException(status_code=400, detail="username required")

    info = _PLANS.get(plan, _PLANS["monthly"])
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(status_code=503, detail="DB unavailable")

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO subscribe_requests
               (username, telegram_id, plan, amount_thb, slip_note, status)
               VALUES ($1, $2, $3, $4, $5, 'pending')
               RETURNING id, created_at""",
            username, int(telegram_id) if telegram_id else None,
            plan, float(info["thb"]), slip_note,
        )

    # Notify admin via Redis pub/sub so kernel can Telegram-notify
    try:
        pub = await _get_pub()
        await pub.publish("SUBSCRIBE_REQUEST", json.dumps({
            "id": row["id"],
            "username": username,
            "plan": plan,
            "amount_thb": float(info["thb"]),
            "slip_note": slip_note,
        }))
    except Exception:
        pass

    return {"id": row["id"], "status": "pending", "message": "ส่งคำขอแล้ว รอ admin อนุมัติครับ"}


@app.get("/signals/subscribe-requests")
async def list_subscribe_requests(status: str = "pending") -> list:
    pool = await _ensure_pg()
    if pool is None:
        return []
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM subscribe_requests WHERE status=$1 ORDER BY created_at DESC",
            status
        )
    return [dict(r) | {"created_at": r["created_at"].isoformat()} for r in rows]


@app.post("/signals/subscribe-request/{req_id}/approve")
async def approve_subscribe_request(req_id: int, request: Request) -> dict:
    """Admin approves a pending request — adds subscriber + sends invite."""
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(status_code=503, detail="DB unavailable")

    async with pool.acquire() as conn:
        req = await conn.fetchrow("SELECT * FROM subscribe_requests WHERE id=$1", req_id)
        if not req:
            raise HTTPException(status_code=404, detail="Request not found")
        if req["status"] != "pending":
            raise HTTPException(status_code=400, detail=f"Already {req['status']}")

        info = _PLANS.get(req["plan"], _PLANS["monthly"])
        # Add to subscribers
        await conn.execute(
            """INSERT INTO signal_subscribers
               (telegram_id, username, plan, paid_amount, status, expires_at)
               VALUES ($1, $2, $3, $4, 'active',
                       NOW() + ($5 || ' days')::INTERVAL)
               ON CONFLICT (telegram_id) DO UPDATE
               SET status='active', expires_at=NOW()+($5||' days')::INTERVAL,
                   paid_amount=EXCLUDED.paid_amount""",
            req["telegram_id"], req["username"], req["plan"],
            float(info["thb"]), str(info["days"]),
        ) if req["telegram_id"] else await conn.execute(
            """INSERT INTO signal_subscribers
               (telegram_id, username, plan, paid_amount, status, expires_at)
               VALUES (0, $1, $2, $3, 'active',
                       NOW() + ($4 || ' days')::INTERVAL)""",
            req["username"], req["plan"],
            float(info["thb"]), str(info["days"]),
        )
        # Mark approved
        await conn.execute(
            "UPDATE subscribe_requests SET status='approved', updated_at=NOW() WHERE id=$1",
            req_id
        )

    # Notify via Redis so kernel sends Telegram invite link
    try:
        pub = await _get_pub()
        await pub.publish("SUBSCRIBE_APPROVED", json.dumps({
            "username": req["username"],
            "telegram_id": req["telegram_id"],
            "plan": req["plan"],
            "days": info["days"],
            "invite_link": _CHANNEL_INVITE,
        }))
    except Exception:
        pass

    return {"status": "approved", "username": req["username"], "plan": req["plan"]}


@app.get("/signals/subscribe-request/status/{req_id}")
async def get_subscribe_request_status(req_id: int) -> dict:
    """Poll endpoint — returns status + invite_link when approved."""
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(status_code=503, detail="DB unavailable")
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status, username, plan FROM subscribe_requests WHERE id=$1", req_id
        )
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    result: dict = {"status": row["status"], "username": row["username"], "plan": row["plan"]}
    if row["status"] == "approved":
        result["invite_link"] = _CHANNEL_INVITE
    return result


@app.post("/signals/subscribe-request/{req_id}/reject")
async def reject_subscribe_request(req_id: int) -> dict:
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(status_code=503, detail="DB unavailable")
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE subscribe_requests SET status='rejected', updated_at=NOW() WHERE id=$1",
            req_id
        )
    return {"status": "rejected"}


# ── Analytics ────────────────────────────────────────────────────────────────

_THB_PER_USD_DEFAULT = float(os.getenv("THB_PER_USD", "35"))
_DAILY_TARGET_THB    = float(os.getenv("DAILY_TARGET_THB", "500"))
_THB_CACHE: dict     = {"rate": _THB_PER_USD_DEFAULT, "updated_at": ""}

_THB_PER_USD = _THB_PER_USD_DEFAULT   # live value — updated by background task


async def _refresh_thb_rate() -> None:
    """Fetch live USD/THB from open.er-api.com every hour."""
    global _THB_PER_USD
    import httpx  # noqa: PLC0415
    while True:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get("https://open.er-api.com/v6/latest/USD")
                if r.status_code == 200:
                    data = r.json()
                    rate = data.get("rates", {}).get("THB")
                    if rate:
                        _THB_PER_USD = float(rate)
                        _THB_CACHE["rate"]       = _THB_PER_USD
                        _THB_CACHE["updated_at"] = data.get("time_last_update_utc", "")
                        log.info("THB rate updated: %.4f THB/USD", _THB_PER_USD)
        except Exception as exc:
            log.warning("THB rate fetch failed: %s — using %.2f", exc, _THB_PER_USD)
        await asyncio.sleep(3600)   # refresh every hour


@app.on_event("startup")
async def _start_thb_refresh():
    asyncio.create_task(_refresh_thb_rate())


_MISSION_TIERS = [
    {"label": "Mission",     "icon": "✅", "color": "#10b981", "thb": _DAILY_TARGET_THB},
    {"label": "Outstanding", "icon": "🌟", "color": "#6366f1", "thb": _DAILY_TARGET_THB * 1.67},
    {"label": "Champion",    "icon": "🏆", "color": "#f59e0b", "thb": _DAILY_TARGET_THB * 3.33},
    {"label": "Legend",      "icon": "💎", "color": "#ec4899", "thb": _DAILY_TARGET_THB * 6.67},
]


def _get_tier(pnl_thb: float) -> dict | None:
    if pnl_thb <= 0:
        return None
    tier = None
    for t in _MISSION_TIERS:
        if pnl_thb >= t["thb"]:
            tier = t
    return tier


@app.get("/mt5/live")
async def mt5_live() -> dict:
    """Live MT5 account data from bridge (published every 5s via Redis)."""
    try:
        r   = await _get_pub()
        raw = await r.get("polis:mt5_live")
        if raw:
            return json.loads(raw)
    except Exception:
        pass
    return {"error": "MT5 bridge ไม่ได้รัน หรือยังไม่ได้ connect"}


@app.post("/mt5/manual")
async def mt5_manual_trade(body: dict) -> dict:
    """Publish a manual trade directly to the MT5 bridge via TRADE_APPROVED."""
    direction = str(body.get("direction", "")).lower()
    symbol    = str(body.get("symbol", "XAUUSD")).upper().replace("/", "")
    lots      = float(body.get("lots", 0.01))
    stop      = float(body.get("stop", 0))

    if direction not in ("long", "short"):
        raise HTTPException(status_code=400, detail="direction must be 'long' or 'short'")
    if lots < 0.01:
        raise HTTPException(status_code=400, detail="lots must be >= 0.01")

    payload = {
        "direction":  direction,
        "symbol":     symbol,
        "lots":       round(lots, 2),
        "stop":       round(stop, 5),
        "confidence": 100,
        "db_id":      None,
        "source":     "manual",
    }
    r = await _get_pub()
    await r.publish("TRADE_APPROVED", json.dumps(payload))
    return {"ok": True, "symbol": symbol, "direction": direction, "lots": lots}


@app.post("/mt5/close/{ticket}")
async def mt5_close_position(ticket: int) -> dict:
    """Request bridge to close a specific MT5 position by ticket."""
    try:
        r = await _get_pub()
        await r.publish("MT5_CLOSE_REQUEST", json.dumps({"ticket": ticket}))
        return {"ok": True, "ticket": ticket}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/mt5/positions")
async def mt5_positions() -> list:
    """Individual open positions from bridge."""
    try:
        r   = await _get_pub()
        raw = await r.get("polis:mt5_positions")
        if raw:
            return json.loads(raw)
    except Exception:
        pass
    return []


@app.get("/mt5/prices")
async def mt5_prices() -> dict:
    """Live bid/ask prices from MT5 bridge (updated every 1s)."""
    try:
        r   = await _get_pub()
        raw = await r.get("polis:mt5_prices")
        if raw:
            return json.loads(raw)
    except Exception:
        pass
    return {}


@app.get("/analytics/thb")
async def thb_config() -> dict:
    return {
        "thb_per_usd":     round(_THB_PER_USD, 4),
        "daily_target_thb": _DAILY_TARGET_THB,
        "updated_at":      _THB_CACHE.get("updated_at", ""),
        "source":          "open.er-api.com" if _THB_CACHE.get("updated_at") else "env",
        "mission_tiers":   _MISSION_TIERS,
    }


@app.get("/analytics/calendar")
async def pnl_calendar(months: int = 3) -> list:
    """Daily P&L grouped by date for the last N months."""
    pool = await _ensure_pg()
    if pool is None:
        return []
    since = datetime.now(timezone.utc) - timedelta(days=months * 31)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT DATE(exit_at AT TIME ZONE 'UTC') AS day,
                      SUM(pnl_usd)   AS pnl_usd,
                      COUNT(*)       AS trades,
                      SUM(CASE WHEN trade_result='WIN' THEN 1 ELSE 0 END) AS wins
               FROM trade_decisions
               WHERE trade_result IS NOT NULL AND exit_at >= $1
               GROUP BY day ORDER BY day""",
            since,
        )
    result = []
    for r in rows:
        pnl_thb = round(float(r["pnl_usd"]) * _THB_PER_USD, 0)
        tier    = _get_tier(pnl_thb)
        result.append({
            "date":       str(r["day"]),
            "pnl_usd":    round(float(r["pnl_usd"]), 2),
            "pnl_thb":    pnl_thb,
            "trades":     r["trades"],
            "wins":       r["wins"],
            "hit_target": pnl_thb >= _DAILY_TARGET_THB,
            "tier":       tier,
        })
    return result


@app.get("/analytics/hours")
async def best_hours() -> list:
    """P&L and win rate grouped by UTC hour of trade close."""
    pool = await _ensure_pg()
    if pool is None:
        return []
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT EXTRACT(HOUR FROM exit_at AT TIME ZONE 'UTC')::int AS hour,
                      COUNT(*)       AS trades,
                      SUM(pnl_usd)   AS pnl_usd,
                      SUM(CASE WHEN trade_result='WIN' THEN 1 ELSE 0 END) AS wins
               FROM trade_decisions
               WHERE trade_result IS NOT NULL AND exit_at IS NOT NULL
               GROUP BY hour ORDER BY hour"""
        )
    return [
        {
            "hour":     r["hour"],
            "trades":   r["trades"],
            "wins":     r["wins"],
            "pnl_usd":  round(float(r["pnl_usd"]), 2),
            "pnl_thb":  round(float(r["pnl_usd"]) * _THB_PER_USD, 0),
            "win_rate": round(r["wins"] / r["trades"] * 100) if r["trades"] > 0 else 0,
        }
        for r in rows
    ]


@app.post("/analytics/hours/apply-best")
async def apply_best_hours() -> dict:
    """Auto-apply top profitable hours as new trading window."""
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(status_code=503, detail="DB unavailable")

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT EXTRACT(HOUR FROM exit_at AT TIME ZONE 'UTC')::int AS hour,
                      COUNT(*) AS trades, SUM(pnl_usd) AS pnl
               FROM trade_decisions
               WHERE trade_result IS NOT NULL AND exit_at IS NOT NULL
                 AND created_at > NOW() - INTERVAL '30 days'
               GROUP BY hour HAVING COUNT(*) >= 3
               ORDER BY SUM(pnl_usd) DESC"""
        )

    if not rows:
        raise HTTPException(status_code=404, detail="ไม่มีข้อมูลเพียงพอ")

    # คัด top profitable hours (positive P&L เท่านั้น)
    good_hours = sorted(
        [r["hour"] for r in rows if float(r["pnl"]) > 0],
        key=lambda h: next(float(r["pnl"]) for r in rows if r["hour"] == h),
        reverse=True,
    )[:8]  # สูงสุด 8 ชั่วโมง

    if not good_hours:
        raise HTTPException(status_code=400, detail="ไม่มีชั่วโมงที่กำไรพอ")

    good_hours.sort()
    new_start = good_hours[0]
    new_end   = good_hours[-1] + 1

    # Apply via Redis SETTINGS_UPDATE
    r = await _get_pub()
    await r.publish("SETTINGS_UPDATE", json.dumps({
        "trading_hours_start": new_start,
        "trading_hours_end":   new_end,
        "ts": datetime.now(timezone.utc).isoformat(),
    }))

    return {
        "status":     "applied",
        "new_start":  new_start,
        "new_end":    new_end,
        "good_hours": good_hours,
        "message":    f"Trading hours: {new_start:02d}:00–{new_end:02d}:00 UTC",
    }


@app.get("/analytics/trades")
async def all_trades_log(limit: int = 500, offset: int = 0) -> list:
    """Full trade log with THB values."""
    pool = await _ensure_pg()
    if pool is None:
        return []
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, symbol, direction, price AS entry_price, fill_price,
                      exit_price, lots, pnl_usd, trade_result, risk_usd,
                      confidence, created_at, exit_at
               FROM trade_decisions
               WHERE trade_result IS NOT NULL
               ORDER BY created_at DESC LIMIT $1 OFFSET $2""",
            limit, offset,
        )
    return [
        {**_row_to_dict(r), "pnl_thb": round(float(r["pnl_usd"] or 0) * _THB_PER_USD, 0)}
        for r in rows
    ]


# ── Backtest / What-If Analyzer ──────────────────────────────────────────────

@app.get("/backtest")
async def backtest(
    min_confidence: int = 0,
    exclude_symbols: str = "",
    reward_ratio: float = 3.0,
) -> dict:
    """What-if analyzer on closed trade history.

    Recalculates P&L assuming trades that WON still win (at new TP = stop × reward_ratio),
    and filters by min_confidence / excluded symbols. Useful for parameter tuning.
    """
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(status_code=503, detail="DB not available")

    excluded = {s.strip().upper() for s in exclude_symbols.split(",") if s.strip()}
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, symbol, direction, price AS entry, fill_price,
                      exit_price, lots, pnl_usd, trade_result,
                      stop, confidence, created_at, exit_at
               FROM trade_decisions
               WHERE trade_result IS NOT NULL AND pnl_usd IS NOT NULL
               ORDER BY created_at ASC"""
        )

    trades_out = []
    for r in rows:
        sym = str(r["symbol"]).upper()
        if sym in excluded:
            continue
        conf = int(r["confidence"] or 0)
        if conf < min_confidence:
            continue

        is_win   = r["trade_result"] == "WIN"
        orig_pnl = float(r["pnl_usd"] or 0)

        # Scale win P&L proportionally by ratio vs. the original 2.0 ratio.
        # Using actual P&L (not stop/lots) avoids bad historical data issues.
        if is_win:
            new_pnl = abs(orig_pnl) * (reward_ratio / 2.0)
        else:
            new_pnl = orig_pnl   # losses unchanged

        trades_out.append({
            "id":           r["id"],
            "symbol":       sym,
            "direction":    r["direction"],
            "confidence":   conf,
            "trade_result": r["trade_result"],
            "orig_pnl":     round(orig_pnl, 2),
            "sim_pnl":      round(new_pnl, 2),
            "created_at":   r["created_at"].isoformat() if r["created_at"] else None,
        })

    total   = len(trades_out)
    wins    = [t for t in trades_out if t["trade_result"] == "WIN"]
    losses  = [t for t in trades_out if t["trade_result"] == "LOSS"]
    sim_pnl = sum(t["sim_pnl"] for t in trades_out)
    orig_pnl_total = sum(t["orig_pnl"] for t in trades_out)
    win_rate = round(len(wins) / total * 100, 1) if total else 0
    avg_win  = round(sum(t["sim_pnl"] for t in wins)   / len(wins),   2) if wins   else 0
    avg_loss = round(sum(t["sim_pnl"] for t in losses) / len(losses), 2) if losses else 0

    # By-symbol breakdown
    sym_map: dict[str, dict] = {}
    for t in trades_out:
        s = t["symbol"]
        if s not in sym_map:
            sym_map[s] = {"trades": 0, "wins": 0, "sim_pnl": 0.0}
        sym_map[s]["trades"] += 1
        sym_map[s]["sim_pnl"] = round(sym_map[s]["sim_pnl"] + t["sim_pnl"], 2)
        if t["trade_result"] == "WIN":
            sym_map[s]["wins"] += 1
    by_symbol = [
        {"symbol": s, "win_rate": round(v["wins"]/v["trades"]*100),
         "trades": v["trades"], "sim_pnl": v["sim_pnl"]}
        for s, v in sym_map.items()
    ]

    return {
        "params":        {"min_confidence": min_confidence, "reward_ratio": reward_ratio,
                          "exclude_symbols": list(excluded)},
        "summary":       {"total": total, "wins": len(wins), "losses": len(losses),
                          "win_rate": win_rate, "sim_pnl": round(sim_pnl, 2),
                          "orig_pnl": round(orig_pnl_total, 2),
                          "pnl_delta": round(sim_pnl - orig_pnl_total, 2),
                          "avg_win": avg_win, "avg_loss": avg_loss},
        "by_symbol":     by_symbol,
        "trades":        trades_out,
    }


# ── Zapier / Make Integration ────────────────────────────────────────────────
#
# Zapier uses POLLING triggers:
#   GET /zapier/triggers/new-episode?since=ISO_TS  → list new episodes
#   GET /zapier/triggers/trade-approved?since=...  → list approved trades
#   GET /zapier/triggers/board-resolution?since=... → list board decisions
#
# Make/Zapier Actions:
#   POST /zapier/actions/post-to-social  → add item to content_queue
#   POST /zapier/actions/trigger-board   → call board meeting
#
# Authentication: pass X-Zapier-Secret header matching ZAPIER_SECRET env var.

_ZAPIER_SECRET = os.getenv("ZAPIER_SECRET", "")


def _check_zapier_auth(request: Request) -> bool:
    if not _ZAPIER_SECRET:
        return True   # no secret configured → open (dev mode)
    return request.headers.get("X-Zapier-Secret") == _ZAPIER_SECRET


@app.get("/zapier/info")
async def zapier_info() -> dict:
    """Service description for Zapier/Make app setup."""
    return {
        "service": "POLIS AI Trading OS",
        "version": "1.0",
        "auth_header": "X-Zapier-Secret",
        "triggers": {
            "new-episode":      "/zapier/triggers/new-episode?since=ISO_TS",
            "trade-approved":   "/zapier/triggers/trade-approved?since=ISO_TS",
            "board-resolution": "/zapier/triggers/board-resolution?since=ISO_TS",
        },
        "actions": {
            "post-to-social": "POST /zapier/actions/post-to-social",
            "trigger-board":  "POST /zapier/actions/trigger-board",
        },
    }


@app.get("/zapier/triggers/new-episode")
async def zapier_new_episodes(since: str = "", request: Request = None) -> list:
    """Zapier polling trigger — returns episodes added to content_queue since timestamp."""
    if not _check_zapier_auth(request):
        raise HTTPException(403, "Invalid X-Zapier-Secret")
    pool = await _ensure_pg()
    if pool is None:
        return []
    ts = since or (datetime.now(timezone.utc) - __import__("datetime").timedelta(hours=1)).isoformat()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, title, caption, asset_url, platforms, created_at
               FROM content_queue
               WHERE source='media_studio' AND type='video'
                 AND created_at > $1::timestamptz
               ORDER BY created_at DESC LIMIT 20""",
            ts,
        )
    return [
        {
            "id":         r["id"],
            "title":      r["title"],
            "caption":    r["caption"],
            "video_url":  r["asset_url"],
            "platforms":  r["platforms"] if isinstance(r["platforms"], list) else json.loads(r["platforms"] or "[]"),
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]


@app.get("/zapier/triggers/trade-approved")
async def zapier_trade_approved(since: str = "", request: Request = None) -> list:
    """Zapier polling trigger — returns recently approved trades."""
    if not _check_zapier_auth(request):
        raise HTTPException(403, "Invalid X-Zapier-Secret")
    pool = await _ensure_pg()
    if pool is None:
        return []
    ts = since or (datetime.now(timezone.utc) - __import__("datetime").timedelta(hours=1)).isoformat()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, symbol, direction, price, lots, confidence, reason, created_at
               FROM trade_decisions
               WHERE outcome='APPROVED' AND created_at > $1::timestamptz
               ORDER BY created_at DESC LIMIT 20""",
            ts,
        )
    return [
        {
            "id":          str(r["id"]),
            "symbol":      r["symbol"],
            "direction":   r["direction"],
            "price":       float(r["price"] or 0),
            "lots":        float(r["lots"] or 0),
            "confidence":  r["confidence"],
            "reason":      r["reason"],
            "created_at":  r["created_at"].isoformat(),
        }
        for r in rows
    ]


@app.get("/zapier/triggers/board-resolution")
async def zapier_board_resolution(since: str = "", request: Request = None) -> list:
    """Zapier polling trigger — returns recent board resolutions."""
    if not _check_zapier_auth(request):
        raise HTTPException(403, "Invalid X-Zapier-Secret")
    pool = await _ensure_pg()
    if pool is None:
        return []
    ts = since or (datetime.now(timezone.utc) - __import__("datetime").timedelta(hours=1)).isoformat()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, resolution, directive, confidence, created_at
               FROM board_resolutions
               WHERE created_at > $1::timestamptz
               ORDER BY created_at DESC LIMIT 10""",
            ts,
        )
    return [
        {
            "id":          str(r["id"]),
            "resolution":  r["resolution"],
            "directive":   r["directive"],
            "confidence":  r["confidence"],
            "created_at":  r["created_at"].isoformat(),
        }
        for r in rows
    ]


@app.post("/zapier/actions/post-to-social")
async def zapier_post_to_social(request: Request) -> dict:
    """Zapier/Make action — add any content to the social queue."""
    if not _check_zapier_auth(request):
        raise HTTPException(403, "Invalid X-Zapier-Secret")
    body = await request.json()
    # Reuse the existing add_to_queue logic
    pool = await _ensure_pg()
    if pool is None:
        raise HTTPException(503, "DB unavailable")
    item_id = str(_uuid.uuid4())
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO content_queue
               (id, source, type, platforms, title, caption, hashtags, asset_url, metadata)
               VALUES ($1,'zapier',$2,$3::jsonb,$4,$5,$6::jsonb,$7,$8::jsonb)""",
            item_id,
            body.get("type", "text"),
            json.dumps(body.get("platforms", ["tiktok", "instagram"])),
            body.get("title"),
            body.get("caption"),
            json.dumps(body.get("hashtags", [])),
            body.get("asset_url"),
            json.dumps(body.get("metadata", {})),
        )
    return {"status": "queued", "id": item_id}


@app.post("/zapier/actions/trigger-board")
async def zapier_trigger_board(request: Request) -> dict:
    """Zapier/Make action — trigger an emergency board meeting."""
    if not _check_zapier_auth(request):
        raise HTTPException(403, "Invalid X-Zapier-Secret")
    r = await _get_pub()
    await r.publish("BOARD_TRIGGER", json.dumps({
        "source": "zapier",
        "ts": datetime.now(timezone.utc).isoformat(),
    }))
    return {"status": "triggered", "message": "Board meeting called via Zapier"}


# ── Social Media Content Generator ───────────────────────────────────────────

_GEMINI_KEY   = os.getenv("GEMINI_API_KEY",   "")
_GROQ_KEY     = os.getenv("GROQ_API_KEY",     "")

_SOCIAL_SYSTEM = (
    "You are a professional social media manager for POLIS, an AI-powered gold trading firm. "
    "Write concise, engaging posts tailored to the requested platform and topic. "
    "Avoid using hashtags unless explicitly asked. "
    "Never mention internal system details (kernel, circuit breaker, etc.) in public posts. "
    "Respond with ONLY the post text, no preamble, no quotes."
)

_PLATFORM_LIMITS: dict[str, int] = {
    "twitter":   280,
    "linkedin":  2000,
    "instagram": 2200,
}

_PLATFORM_TONE: dict[str, str] = {
    "twitter":   "punchy, max 2 sentences, casual but confident",
    "linkedin":  "professional, insightful, 3-4 sentences, add a thought-leadership angle",
    "instagram": "engaging, visual-friendly language, 2-3 sentences, end with a call to action",
}


async def _llm_generate(prompt: str) -> str:
    import httpx as _httpx

    # Try Gemini first
    if _GEMINI_KEY:
        try:
            async with _httpx.AsyncClient() as client:
                r = await client.post(
                    f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={_GEMINI_KEY}",
                    json={"contents": [{"parts": [{"text": f"{_SOCIAL_SYSTEM}\n\n{prompt}"}]}]},
                    timeout=15.0,
                )
                data = r.json()
                text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
                if text:
                    return text
        except Exception as exc:
            log.warning("Social Gemini error: %s", exc)

    # Groq fallback
    if _GROQ_KEY:
        try:
            async with _httpx.AsyncClient() as client:
                r = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {_GROQ_KEY}"},
                    json={
                        "model": "meta-llama/llama-4-scout-17b-16e-instruct",
                        "messages": [
                            {"role": "system", "content": _SOCIAL_SYSTEM},
                            {"role": "user",   "content": prompt},
                        ],
                        "max_tokens": 300,
                    },
                    timeout=15.0,
                )
                text = r.json()["choices"][0]["message"]["content"].strip()
                if text:
                    return text
        except Exception as exc:
            log.warning("Social Groq error: %s", exc)

    return "Markets are moving — stay sharp. Our AI systems are tracking every tick. 📊"


@app.post("/social/draft")
async def social_draft(request: Request) -> dict:
    """Generate an AI social media post draft."""
    body      = await request.json()
    platform  = str(body.get("platform", "twitter")).lower()
    topic     = str(body.get("topic", "gold market update"))
    char_limit = _PLATFORM_LIMITS.get(platform, 280)
    tone      = _PLATFORM_TONE.get(platform, "professional")

    # Enrich prompt with live world data if available
    world_ctx = ""
    try:
        r = await _get_pub()
        raw = await r.get(_WORLD_KEY)
        if raw:
            w = json.loads(raw)
            gold   = w.get("gold_price")
            regime = w.get("regime", "")
            fg     = w.get("fg_value")
            if gold:
                world_ctx = (
                    f" Current XAU/USD: ${gold:.0f}. "
                    f"Market regime: {regime}. "
                    f"Fear & Greed: {fg}/100."
                ) if gold else ""
    except Exception:
        pass

    prompt = (
        f"Write a {platform} post about: {topic}.{world_ctx} "
        f"Tone: {tone}. "
        f"Max {char_limit} characters."
    )

    draft = await _llm_generate(prompt)
    return {
        "platform": platform,
        "topic":    topic,
        "draft":    draft,
        "chars":    len(draft),
        "limit":    char_limit,
    }


@app.get("/social/ideas")
async def social_ideas() -> list:
    """Recent trade events formatted as social-ready content ideas."""
    pool = await _ensure_pg()
    items: list[dict] = []
    if pool:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT symbol, direction, confidence, pnl_usd, trade_result, created_at
                   FROM trade_decisions
                   WHERE outcome='APPROVED' AND created_at >= NOW() - INTERVAL '24 hours'
                   ORDER BY created_at DESC LIMIT 10"""
            )
        for r in rows:
            items.append({
                "symbol":    r["symbol"],
                "direction": r["direction"],
                "confidence": int(r["confidence"] or 0),
                "pnl_usd":   float(r["pnl_usd"] or 0) if r["pnl_usd"] is not None else None,
                "result":    r["trade_result"],
                "ts":        r["created_at"].isoformat(),
            })
    return items


@app.websocket("/ws/feed")
async def feed(ws: WebSocket) -> None:
    global _listener_started
    if not _listener_started:
        _listener_started = True
        asyncio.create_task(_redis_listener())

    await ws.accept()
    _clients.append(ws)
    for event in _recent:
        await ws.send_text(json.dumps(event))
    try:
        while True:
            await asyncio.sleep(30)
            await ws.send_text(json.dumps({
                "topic": "PING",
                "data":  {"clients": len(_clients)},
                "ts":    datetime.now(timezone.utc).isoformat(),
            }))
    except WebSocketDisconnect:
        pass
    finally:
        if ws in _clients:
            _clients.remove(ws)
