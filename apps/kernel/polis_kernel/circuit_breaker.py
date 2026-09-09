"""Circuit Breaker — halts trading automatically when safety thresholds are breached.

Triggers:
  1. CB_MAX_CONSECUTIVE_REJECTS — N consecutive SIGNAL_REJECTED / POLICY_BLOCKED
  2. DAILY_BUDGET_USD           — cumulative risk notional for today exceeds budget
  3. MAX_DAILY_LOSS_USD         — realized P&L today drops below -limit
     • At 50% of limit → early warning (Telegram) + step-down (max_risk halved)
     • At 100% of limit → hard CB (trading halts)

Win Streak Bonus:
  • 3 consecutive wins → max_risk restored to base then boosted +20% (cap 1.5×)
  • Any loss → streak resets, max_risk restored to base

Auto-resets at midnight UTC (07:00 Thai time) each day.
Manual reset: /resume via Telegram also clears the breaker.
"""
import asyncio
import json
import logging
import os
from datetime import datetime, timezone, timedelta

import redis.asyncio as aioredis

log = logging.getLogger("kernel.circuit_breaker")

_MAX_CONSEC        = int(os.getenv("CB_MAX_CONSECUTIVE_REJECTS", "5"))
_DAILY_BUDGET      = float(os.getenv("DAILY_BUDGET_USD", "620"))
_MAX_DAILY_LOSS    = float(os.getenv("MAX_DAILY_LOSS_USD", "300"))
_BASE_RISK         = float(os.getenv("MAX_RISK", "0.005"))
_WIN_STREAK_MIN    = 3
_WIN_STREAK_MULT   = 1.2
_MAX_RISK_CAP      = _BASE_RISK * 1.5
_CB_KEY            = "polis:circuit_breaker"
_REDIS_URL         = os.getenv("REDIS_URL", "redis://redis:6379/0")
_RECOVERY_KEY      = "polis:recovery_scale"
_RECOVERY_LOSSES   = 3      # consecutive losses → enter recovery (lot ×0.5)
_RECOVERY_WINS_EXIT = 3     # consecutive wins in recovery → exit


def _seconds_until_midnight_utc() -> float:
    now = datetime.now(timezone.utc)
    tomorrow = (now + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return (tomorrow - now).total_seconds()


class CircuitBreaker:
    def __init__(self, bus, discord_notifier=None, telegram_bot=None) -> None:
        self._bus          = bus
        self._discord      = discord_notifier
        self._telegram     = telegram_bot
        self._triggered    = False
        self._reason       = ""
        self._consec       = 0
        self._win_streak      = 0
        self._day_notional    = 0.0
        self._day_pnl         = 0.0
        self._warned_50       = False
        self._stepped_down    = False
        self._recovery_mode   = False
        self._consec_losses   = 0    # consecutive real trade losses
        self._recovery_wins   = 0    # consecutive wins while in recovery
        self._day_key      = datetime.now(timezone.utc).date()
        self._triggered_at: str = ""
        self._redis        = aioredis.from_url(_REDIS_URL)

        bus.subscribe("SIGNAL_REJECTED", self._on_reject)
        bus.subscribe("POLICY_BLOCKED",  self._on_policy_blocked)
        bus.subscribe("TRADE_APPROVED",  self._on_approved)
        bus.subscribe("TRADE_CLOSED",    self._on_closed)

        log.info(
            "CircuitBreaker armed — max_consec=%d  daily_budget=$%.0f  "
            "max_daily_loss=$%.0f  base_risk=%.2f%%  win_streak=%d",
            _MAX_CONSEC, _DAILY_BUDGET, _MAX_DAILY_LOSS,
            _BASE_RISK * 100, _WIN_STREAK_MIN,
        )

    # ── public ───────────────────────────────────────────────────
    def is_triggered(self) -> bool:
        return self._triggered

    async def _save_state(self) -> None:
        try:
            await self._redis.hset(_CB_KEY, mapping={
                "triggered":      "1" if self._triggered else "0",
                "reason":         self._reason or "",
                "consec":         str(self._consec),
                "win_streak":     str(self._win_streak),
                "day_notional":   str(round(self._day_notional, 2)),
                "day_pnl":        str(round(self._day_pnl, 2)),
                "daily_budget":   str(_DAILY_BUDGET),
                "max_daily_loss": str(_MAX_DAILY_LOSS),
                "max_consec":     str(_MAX_CONSEC),
                "triggered_at":   self._triggered_at,
            })
        except Exception as exc:
            log.debug("CB Redis write failed: %s", exc)

    def reset(self) -> None:
        """Called by Telegram /resume or midnight auto-reset."""
        if self._triggered:
            log.info("CircuitBreaker RESET — resuming signal processing")
        self._triggered    = False
        self._reason       = ""
        self._consec       = 0
        self._win_streak   = 0
        self._day_notional = 0.0
        self._day_pnl      = 0.0
        self._warned_50    = False
        self._stepped_down = False
        self._triggered_at = ""
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(self._save_state())
                loop.create_task(self._bus.publish("CIRCUIT_BREAKER_RESET", {
                    "ts": datetime.now(timezone.utc).isoformat(),
                }))
                # Restore base risk on reset
                loop.create_task(self._publish_risk_override(_BASE_RISK, "CB reset"))
        except Exception:
            pass

    # ── event handlers ────────────────────────────────────────────
    async def _on_reject(self, data: dict) -> None:
        """SIGNAL_REJECTED — AI decided signal is bad → count toward CB."""
        self._refresh_day()
        self._consec += 1
        log.debug("CircuitBreaker consec=%d (signal reject)", self._consec)
        await self._save_state()
        if self._consec >= _MAX_CONSEC:
            await self._trigger(
                f"สัญญาณถูกปฏิเสธ {self._consec} ครั้งติดต่อกัน (threshold={_MAX_CONSEC})"
            )

    async def _on_policy_blocked(self, data: dict) -> None:
        """POLICY_BLOCKED — system rule blocked (hours, budget, CB) → reset consec, don't count."""
        self._refresh_day()
        self._consec = 0
        log.debug("CircuitBreaker: policy block — consec reset (reason: %s)", data.get("reason", "?"))
        await self._save_state()

    async def _on_closed(self, data: dict) -> None:
        self._refresh_day()
        pnl    = float(data.get("pnl_usd", 0))
        result = str(data.get("result", data.get("trade_result", ""))).upper()
        symbol = str(data.get("symbol", ""))

        self._day_pnl += pnl

        # ── Win streak tracking ───────────────────────────────
        if result == "WIN":
            self._consec_losses = 0
            if self._recovery_mode:
                self._recovery_wins += 1
                if self._recovery_wins >= _RECOVERY_WINS_EXIT:
                    self._recovery_mode = False
                    self._recovery_wins = 0
                    await self._set_recovery_scale(1.0)
                    log.info("RECOVERY MODE OFF — %d consecutive wins", _RECOVERY_WINS_EXIT)
                    if self._telegram:
                        try:
                            await self._telegram.notify(
                                f"✅  <b>Recovery Mode OFF</b>\n\n"
                                f"ชนะ {_RECOVERY_WINS_EXIT} ไม้ติดต่อกัน — lot กลับสู่ปกติแล้ว"
                            )
                        except Exception:
                            pass
            self._win_streak += 1
            if self._win_streak == _WIN_STREAK_MIN:
                new_risk = min(_BASE_RISK * _WIN_STREAK_MULT, _MAX_RISK_CAP)
                await self._publish_risk_override(new_risk, f"win streak {self._win_streak}")
                log.info(
                    "WIN STREAK %d — boosting max_risk %.2f%% → %.2f%%",
                    self._win_streak, _BASE_RISK * 100, new_risk * 100,
                )
                if self._telegram:
                    try:
                        await self._telegram.notify(
                            f"🔥  <b>Win Streak ×{self._win_streak}!</b>\n\n"
                            f"ชนะ {self._win_streak} ครั้งติดต่อกัน 🎯\n"
                            f"max_risk: {_BASE_RISK*100:.2f}% → <b>{new_risk*100:.2f}%</b>\n\n"
                            f"🤖 <i>POLIS aggressive mode</i>"
                        )
                    except Exception:
                        pass
        else:
            if self._win_streak >= _WIN_STREAK_MIN and result == "LOSS":
                await self._publish_risk_override(_BASE_RISK, "streak broken")
                log.info("Win streak broken — restoring max_risk to %.2f%%", _BASE_RISK * 100)
            self._win_streak    = 0
            self._recovery_wins = 0
            self._consec_losses += 1
            if not self._recovery_mode and self._consec_losses >= _RECOVERY_LOSSES:
                self._recovery_mode = True
                await self._set_recovery_scale(0.5)
                log.warning("RECOVERY MODE ON — %d consecutive losses → lot ×0.5", self._consec_losses)
                if self._telegram:
                    try:
                        await self._telegram.notify(
                            f"⚠️  <b>Recovery Mode ON</b>\n\n"
                            f"แพ้ {self._consec_losses} ไม้ติดต่อกัน\n"
                            f"ลด lot เหลือ 50% จนกว่าจะชนะ {_RECOVERY_WINS_EXIT} ไม้ติด\n"
                            f"🛡️  ระบบยังเทรดอยู่ แค่ conservative ขึ้น"
                        )
                    except Exception:
                        pass

        await self._save_state()

        # ── Drawdown checks ───────────────────────────────────
        warning_threshold = -_MAX_DAILY_LOSS * 0.5

        if self._day_pnl <= warning_threshold and not self._warned_50:
            self._warned_50 = True
            remaining = _MAX_DAILY_LOSS + self._day_pnl   # how much left before hard stop
            log.warning(
                "DRAWDOWN WARNING 50%% — day P&L $%.0f / limit -$%.0f",
                self._day_pnl, _MAX_DAILY_LOSS,
            )
            # Step-down: halve max_risk
            if not self._stepped_down:
                self._stepped_down = True
                step_risk = _BASE_RISK * 0.5
                await self._publish_risk_override(step_risk, "drawdown step-down 50%")
                log.info("RISK STEP-DOWN → %.2f%% (was %.2f%%)", step_risk * 100, _BASE_RISK * 100)

            if self._telegram:
                try:
                    await self._telegram.notify(
                        f"⚠️  <b>Drawdown Warning — 50%</b>\n\n"
                        f"📉  เสียไปวันนี้: <b>${abs(self._day_pnl):,.0f}</b>\n"
                        f"🚧  เหลืออีก: <b>${remaining:,.0f}</b> จึงจะ CB\n\n"
                        f"⚙️  ลด max_risk เหลือครึ่งเดียวแล้ว ({_BASE_RISK*50:.2f}%)\n"
                        f"🤖  <i>POLIS defensive mode</i>"
                    )
                except Exception:
                    pass

        if self._day_pnl <= -_MAX_DAILY_LOSS and not self._triggered:
            await self._trigger(
                f"Daily loss limit reached — "
                f"P&L today: ${self._day_pnl:,.0f} / limit: -${_MAX_DAILY_LOSS:,.0f}"
            )

    async def _on_approved(self, data: dict) -> None:
        self._refresh_day()
        self._consec = 0
        risk_usd = float(data.get("risk_usd", 0))
        if not risk_usd:
            lots     = float(data.get("lots", 0))
            stop     = float(data.get("stop", 0))
            risk_usd = lots * 100 * stop
        self._day_notional += risk_usd
        await self._save_state()
        if self._day_notional >= _DAILY_BUDGET and not self._triggered:
            await self._trigger(
                f"งบความเสี่ยงรายวันหมดแล้ว — ใช้ไป ${self._day_notional:,.0f} "
                f"/ ${_DAILY_BUDGET:,.0f}"
            )

    # ── internals ─────────────────────────────────────────────────
    def _refresh_day(self) -> None:
        today = datetime.now(timezone.utc).date()
        if today != self._day_key:
            was_triggered = self._triggered
            self._day_key      = today
            self._day_notional = 0.0
            self._day_pnl      = 0.0
            self._win_streak   = 0
            self._warned_50     = False
            self._stepped_down  = False
            self._consec        = 0
            self._consec_losses = 0
            self._recovery_wins = 0
            self._triggered     = False
            self._reason        = ""
            self._triggered_at  = ""
            log.info(
                "CircuitBreaker: new day — counters reset%s",
                " (triggered flag cleared)" if was_triggered else "",
            )
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    loop.create_task(self._save_state())
            except Exception:
                pass

    async def _set_recovery_scale(self, scale: float) -> None:
        """Store lot scale factor in Redis for trade_handler to read."""
        try:
            await self._redis.set(_RECOVERY_KEY, str(scale), ex=86400)
        except Exception as exc:
            log.debug("Recovery scale set failed: %s", exc)

    async def _publish_risk_override(self, new_risk: float, reason: str) -> None:
        """Publish RISK_OVERRIDE to Redis so control_listener adjusts policy.max_risk live."""
        try:
            payload = json.dumps({
                "max_risk": round(new_risk, 5),
                "source":   f"circuit_breaker:{reason}",
                "ts":       datetime.now(timezone.utc).isoformat(),
            })
            await self._redis.publish("RISK_OVERRIDE", payload)
        except Exception as exc:
            log.warning("CB risk override publish failed: %s", exc)

    async def _trigger(self, reason: str) -> None:
        if self._triggered:
            return
        self._triggered    = True
        self._reason       = reason
        self._triggered_at = datetime.now(timezone.utc).isoformat()
        log.warning("CIRCUIT BREAKER TRIGGERED — %s", reason)
        await self._save_state()
        await self._bus.publish("CIRCUIT_BREAKER_TRIGGERED", {
            "reason":       reason,
            "consec":       self._consec,
            "day_notional": self._day_notional,
            "day_pnl":      self._day_pnl,
            "daily_budget": _DAILY_BUDGET,
            "triggered_at": self._triggered_at,
        })
        await self._notify(reason)

    async def _notify(self, reason: str) -> None:
        if self._discord:
            try:
                await self._discord._post({"embeds": [{
                    "title":       "🚨  CIRCUIT BREAKER TRIGGERED",
                    "description": reason,
                    "color":       0xef4444,
                    "fields": [
                        {"name": "สถานะ", "value": "⛔ หยุดรับสัญญาณ", "inline": True},
                        {"name": "Reset", "value": "/resume หรือ midnight UTC", "inline": True},
                    ],
                    "footer": {"text": "POLIS Circuit Breaker"},
                }]})
            except Exception as exc:
                log.warning("CB discord notify failed: %s", exc)

        if self._telegram:
            try:
                await self._telegram.notify(
                    f"🚨  <b>Circuit Breaker เปิด</b>\n\n"
                    f"⛔  {reason}\n\n"
                    f"ระบบหยุดรับสัญญาณแล้ว\n"
                    f"ใช้ /resume เพื่อเปิดใหม่"
                )
            except Exception as exc:
                log.warning("CB telegram notify failed: %s", exc)

    # ── midnight auto-reset ───────────────────────────────────────
    async def run(self) -> None:
        while True:
            wait = _seconds_until_midnight_utc()
            log.debug("CircuitBreaker: next auto-reset in %.0f min", wait / 60)
            await asyncio.sleep(wait)
            self.reset()
            log.info("CircuitBreaker: midnight auto-reset complete")
