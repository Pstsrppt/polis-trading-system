"""Boot sequence for the POLIS kernel."""
import asyncio
import json
import os
import traceback

from polis_event_bus import EventBus
from polis_registry import AgentRegistry, SkillRegistry
from polis_policy import PolicyEngine
from polis_observability import get_logger

from .scheduler import Scheduler
from .orchestrator import Orchestrator
from .healthcheck import HealthMonitor
from .mock_signals import MockTradingSignals
from .research_agent import ResearchAgent
from .trade_handler import TradeHandler
from .board_meeting import BoardMeeting
from .policy_governor import PolicyGovernor
from .memory_store import MemoryStore
from .signal_filter import SignalFilter
from .discord_notifier import DiscordNotifier
from .telegram_bot import TelegramBot
from .daily_briefing import DailyBriefing
from .circuit_breaker import CircuitBreaker
from .trade_tracker import TradeTracker
from .world_model import WorldModel
from .cost_tracker import cost_tracker
from . import db

log = get_logger("kernel.boot")

import redis.asyncio as aioredis  # noqa: E402 — after logger setup


async def _control_listener(bus, policy) -> None:
    """Listen for dashboard control commands published by the gateway."""
    redis_url = os.getenv("REDIS_URL", "redis://redis:6379/0")
    log.info("Control listener active — TRADING_PAUSED/RESUMED / RISK_OVERRIDE / BOARD_TRIGGER / SETTINGS_UPDATE")
    while True:
        try:
            r = aioredis.from_url(redis_url, socket_timeout=None, socket_connect_timeout=5, socket_keepalive=True)
            pubsub = r.pubsub()
            await pubsub.subscribe(
                "TRADING_PAUSED", "TRADING_RESUMED",
                "RISK_OVERRIDE", "BOARD_TRIGGER", "SETTINGS_UPDATE",
            )
            async for msg in pubsub.listen():
                if msg["type"] != "message":
                    continue
                topic = msg["channel"].decode()
                try:
                    data = json.loads(msg["data"])
                except Exception:
                    continue
                if topic == "TRADING_PAUSED":
                    policy.paused = True
                    log.warning("TRADING PAUSED by dashboard")
                    await bus.dispatch("TRADING_PAUSED", data)
                elif topic == "TRADING_RESUMED":
                    policy.paused = False
                    log.info("TRADING RESUMED by dashboard")
                    await bus.dispatch("TRADING_RESUMED", data)
                elif topic == "RISK_OVERRIDE":
                    new_risk = float(data.get("max_risk", policy.max_risk))
                    old = policy.max_risk
                    policy.max_risk = round(new_risk, 4)
                    log.info("RISK_OVERRIDE: %.2f%% → %.2f%%", old * 100, new_risk * 100)
                    await bus.dispatch("POLICY_ADJUSTED", {
                        "old_risk": old, "new_risk": policy.max_risk,
                        "directive": "Manual override from dashboard",
                    })
                elif topic == "BOARD_TRIGGER":
                    log.info("BOARD_TRIGGER from dashboard — dispatching")
                    await bus.dispatch("BOARD_TRIGGER", data)
                elif topic == "SETTINGS_UPDATE":
                    log.info("SETTINGS_UPDATE from dashboard: %s", data)
                    await bus.dispatch("SETTINGS_UPDATE", data)
        except Exception as exc:
            log.warning("Control listener disconnected: %s — retrying in 5s", exc)
            await asyncio.sleep(5)


async def _weekly_subscriber_report(telegram_bot) -> None:
    """ส่งสรุปผล signals รายสัปดาห์ให้ admin + broadcast ทุกวันจันทร์ 08:00 Thai"""
    import httpx
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td
    _TH = _tz(_td(hours=7))

    def _secs_until_monday():
        now = _dt.now(_TH)
        days_ahead = (7 - now.weekday()) % 7 or 7
        target = (now + _td(days=days_ahead)).replace(
            hour=8, minute=0, second=0, microsecond=0
        )
        return max(60, (target - now).total_seconds())

    gw_url = os.getenv("GATEWAY_URL", "http://gateway:8000")
    while True:
        await asyncio.sleep(_secs_until_monday())
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r  = await client.get(f"{gw_url}/analytics/trades?limit=500")
                r2 = await client.get(f"{gw_url}/analytics/thb")
                subs_r = await client.get(f"{gw_url}/signals/subscribers")

            trades = r.json() if r.status_code == 200 else []
            cfg    = r2.json() if r2.status_code == 200 else {}
            subs   = subs_r.json() if subs_r.status_code == 200 else []

            week_ago = (_dt.now(_tz.utc) - _td(days=7)).isoformat()
            weekly = [t for t in trades if (t.get("exit_at") or "") >= week_ago]

            if not weekly:
                continue

            wins    = [t for t in weekly if t.get("trade_result") == "WIN"]
            losses  = [t for t in weekly if t.get("trade_result") == "LOSS"]
            wr      = round(len(wins) / len(weekly) * 100) if weekly else 0
            pnl_usd = sum(t.get("pnl_usd", 0) for t in weekly)
            thb     = cfg.get("thb_per_usd", 34)
            pnl_thb = round(pnl_usd * thb)
            active_subs = len([s for s in subs if s.get("status") == "active"])

            report = (
                f"📊  <b>POLIS Weekly Signal Report</b>\n\n"
                f"📅  สัปดาห์ที่ผ่านมา\n\n"
                f"📈  <b>ผลการเทรด:</b>\n"
                f"    ├  Total Signals  <b>{len(weekly)}</b>\n"
                f"    ├  ✅ Wins         <b>{len(wins)}</b>\n"
                f"    ├  ❌ Losses       <b>{len(losses)}</b>\n"
                f"    ├  Win Rate        <b>{wr}%</b>\n"
                f"    └  Net P&L         <b>${pnl_usd:+.2f}</b>  (฿{pnl_thb:+,.0f})\n\n"
                f"👥  Active Subscribers: <b>{active_subs}</b>\n\n"
                f"🤖  <i>POLIS AI Trading OS — Weekly Summary</i>"
            )

            if telegram_bot:
                await telegram_bot.notify(report)
                await telegram_bot.broadcast_signal(report)
                log.info("Weekly subscriber report sent — %d trades, WR=%d%%", len(weekly), wr)

        except Exception as exc:
            log.warning("Weekly report error: %s", exc)


async def _expire_subscribers_loop(telegram_bot) -> None:
    """Check for expired subscribers every hour and notify admin."""
    import httpx
    gw_url = os.getenv("GATEWAY_URL", "http://gateway:8000")
    while True:
        await asyncio.sleep(3600)
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.post(f"{gw_url}/signals/expire-subscribers")
                data = r.json()
            count = data.get("expired_count", 0)
            if count > 0:
                names = ", ".join(f"@{e['username']}" for e in data.get("expired", []))
                log.info("Auto-expired %d subscriber(s): %s", count, names)
                if telegram_bot:
                    await telegram_bot.notify(
                        f"⏰  <b>หมดอายุอัตโนมัติ {count} ราย</b>\n\n"
                        f"👤  {names}\n\n"
                        f"ใช้ /subs เพื่อดูรายชื่อปัจจุบัน"
                    )
        except Exception as exc:
            log.warning("expire-subscribers loop error: %s", exc)


async def _external_listener(bus) -> None:
    """Relay external Redis pub/sub events into the in-process bus.

    Subscribes to:
      TRADE_SIGNAL  — TwelveData publisher, TradingView webhooks
      TRADE_CLOSED  — Gateway manual-close endpoint

    Using bus.dispatch() avoids re-publishing to Redis (no infinite loop).
    """
    redis_url = os.getenv("REDIS_URL", "redis://redis:6379/0")
    log.info("External listener active — TRADE_SIGNAL + TRADE_CLOSED via Redis")
    while True:
        try:
            r = aioredis.from_url(
                redis_url,
                socket_timeout=None,
                socket_connect_timeout=5,
                socket_keepalive=True,
            )
            pubsub = r.pubsub()
            await pubsub.subscribe("TRADE_SIGNAL", "TRADE_CLOSED", "SUBSCRIBE_REQUEST", "SUBSCRIBE_APPROVED")
            async for msg in pubsub.listen():
                if msg["type"] != "message":
                    continue
                topic = msg["channel"].decode()
                try:
                    data = json.loads(msg["data"])
                except Exception:
                    continue
                await bus.dispatch(topic, data)
        except Exception as exc:
            log.warning("External listener disconnected: %s — retrying in 5s", exc)
            await asyncio.sleep(5)


async def _guarded(name: str, coro) -> None:
    try:
        await coro
    except Exception:
        log.error("CRASH in %s:\n%s", name, traceback.format_exc())
        raise


def _validate_env() -> None:
    """Check env vars at startup — fail fast on missing required, warn on missing optional."""
    required = {
        "POSTGRES_URL": "PostgreSQL connection string",
        "REDIS_URL":    "Redis connection string",
    }
    optional = {
        "GEMINI_API_KEY":          "LLM (Gemini 2.0 Flash) — research/trade agents will be degraded",
        "GROQ_API_KEY":            "LLM fallback (Groq) — no fallback if Gemini fails",
        "TELEGRAM_BOT_TOKEN":      "Telegram bot — /status, /world, alerts disabled",
        "TELEGRAM_CHAT_ID":        "Telegram destination — bot will not know where to send",
        "DISCORD_WEBHOOK_URL":     "Discord notifications and daily briefing disabled",
        "TWELVE_DATA_API_KEY":     "TwelveData prices — will use yfinance fallback",
        "OANDA_API_KEY":           "Broker disabled — will run in simulation mode",
    }

    missing_required = [k for k in required if not os.getenv(k)]
    if missing_required:
        for k in missing_required:
            log.error("REQUIRED env var missing: %s (%s)", k, required[k])
        raise SystemExit(f"Cannot start: {len(missing_required)} required env var(s) missing")

    missing_optional = [(k, v) for k, v in optional.items() if not os.getenv(k)]
    if missing_optional:
        log.warning("Optional env vars not set — some features disabled:")
        for k, desc in missing_optional:
            log.warning("  %-32s  %s", k, desc)
    else:
        log.info("All optional env vars present")


async def boot() -> None:
    _validate_env()
    log.info("POLIS kernel booting…")
    await db.init()
    memory = MemoryStore()
    await memory.init()

    bus    = EventBus()
    skills = SkillRegistry.load()
    agents = AgentRegistry(bus=bus)
    policy = PolicyEngine.from_config()

    orchestrator = Orchestrator(bus=bus, agents=agents, skills=skills, policy=policy)
    scheduler    = Scheduler(orchestrator=orchestrator)
    health       = HealthMonitor(agents=agents, bus=bus)
    signal_source = os.getenv("SIGNAL_SOURCE", "mock")
    if signal_source == "mock":
        signals = MockTradingSignals(bus=bus)
        log.info("Signal source: mock (60s synthetic signals)")
    elif signal_source == "twelvedata":
        from .signal_publisher import TwelveDataPublisher
        signals = TwelveDataPublisher(bus=bus)
        log.info("Signal source: TwelveData REST API")
    else:
        signals = None
        log.info("Signal source: %s — external publisher via Redis", signal_source)

    _telegram    = TelegramBot(bus=bus, policy=policy, db_module=db)
    _discord     = DiscordNotifier(bus=bus)
    _research    = ResearchAgent(bus=bus, memory=memory)
    _cb          = CircuitBreaker(bus=bus, discord_notifier=_discord, telegram_bot=_telegram)
    _telegram.set_circuit_breaker(_cb)
    _filter      = SignalFilter(bus=bus, telegram_bot=_telegram, circuit_breaker=_cb, policy=policy)
    _trade       = TradeHandler(bus=bus, policy=policy, memory=memory)
    board        = BoardMeeting(bus=bus, interval=300)
    _gov         = PolicyGovernor(bus=bus, policy=policy)
    _briefing    = DailyBriefing(db_module=db, telegram_bot=_telegram)
    _tracker     = TradeTracker(bus=bus, db_module=db, discord_notifier=_discord, telegram_bot=_telegram)
    await _tracker.init()

    await orchestrator.bring_up_executive_board()
    log.info("Executive Board online · CEO/CTO/CFO/COO/CMO")

    world = WorldModel(bus=bus, telegram_bot=_telegram)

    coros = [
        _guarded("scheduler",    scheduler.run()),
        _guarded("health",       health.run()),
        _guarded("board",        board.run()),
        _guarded("telegram",     _telegram.run()),
        _guarded("briefing",     _briefing.run()),
        _guarded("circuit_breaker", _cb.run()),
        _guarded("control",      _control_listener(bus, policy)),
        _guarded("world_model",  world.run()),
        _guarded("cost_flush",   cost_tracker.flush()),
        _guarded("expire_subs",      _expire_subscribers_loop(_telegram)),
        _guarded("weekly_report",    _weekly_subscriber_report(_telegram)),
    ]
    if signals:
        coros.append(_guarded("signals", signals.run()))
    # Always listen for external events from Redis:
    #   TRADE_SIGNAL — TradingView webhooks / external publishers
    #   TRADE_CLOSED — Gateway manual-close endpoint (keeps SignalFilter in sync)
    coros.append(_guarded("ext_listener", _external_listener(bus)))
    await asyncio.gather(*coros)


if __name__ == "__main__":
    asyncio.run(boot())
