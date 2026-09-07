"""Daily P&L Briefing — posts a summary to Discord + Telegram at 08:00 Thai time."""
import asyncio
import logging
import os
from datetime import datetime, timezone, timedelta

import httpx

log = logging.getLogger("kernel.briefing")

_TZ_THAI      = timezone(timedelta(hours=7))
_SEND_HOUR    = 8    # 08:00 Thai — morning briefing
_EVENING_HOUR = 22   # 22:00 Thai — P&L report after session


def _seconds_until(hour: int) -> float:
    now    = datetime.now(_TZ_THAI)
    target = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    if now >= target:
        target += timedelta(days=1)
    return (target - now).total_seconds()


def _seconds_until_next_briefing() -> float:
    return _seconds_until(_SEND_HOUR)


class DailyBriefing:
    def __init__(self, db_module, telegram_bot=None) -> None:
        self._db  = db_module
        self._tg  = telegram_bot
        self._url = os.getenv("DISCORD_WEBHOOK_URL", "")
        if not self._url and not self._tg:
            log.warning("DailyBriefing: no Discord webhook and no Telegram — briefing disabled")
        elif not self._url:
            log.info("DailyBriefing: Telegram only (DISCORD_WEBHOOK_URL not set)")
        elif not self._tg:
            log.info("DailyBriefing: Discord only (no Telegram bot)")

    async def run(self) -> None:
        log.info(
            "DailyBriefing scheduled — morning 08:00 + evening 22:00 Thai time"
        )
        while True:
            # รอถึง event ถัดไป (08:00 หรือ 22:00)
            now_h = datetime.now(_TZ_THAI).hour
            if now_h < _SEND_HOUR or now_h >= _EVENING_HOUR:
                await asyncio.sleep(_seconds_until(_SEND_HOUR))
                await self._send()
            elif now_h < _EVENING_HOUR:
                await asyncio.sleep(_seconds_until(_EVENING_HOUR))
                await self._send_evening()

    async def _send_evening(self) -> None:
        """22:00 Thai — ส่งสรุป P&L ประจำวันจริง (closed trades)"""
        import httpx as _httpx  # noqa: PLC0415
        try:
            thb_rate = float(os.getenv("THB_PER_USD", "34"))
            pool = getattr(self._db, "_pool", None) or getattr(self._db, "pool", None)

            gw_url = os.getenv("GATEWAY_URL", "http://gateway:8000")
            async with _httpx.AsyncClient(timeout=10.0) as client:
                # ดึง trades วันนี้
                r = await client.get(f"{gw_url}/analytics/calendar?months=1")
                days = r.json() if r.status_code == 200 else []
                r2 = await client.get(f"{gw_url}/analytics/thb")
                cfg = r2.json() if r2.status_code == 200 else {}
                thb_rate = cfg.get("thb_per_usd", thb_rate)

            today_str = datetime.now(_TZ_THAI).strftime("%Y-%m-%d")
            today = next((d for d in days if d.get("date") == today_str), None)

            if not today or today.get("trades", 0) == 0:
                return   # ไม่มี trade วันนี้ ไม่ส่ง

            pnl_usd = today.get("pnl_usd", 0)
            pnl_thb = today.get("pnl_thb", 0)
            trades  = today.get("trades", 0)
            wins    = today.get("wins", 0)
            losses  = trades - wins
            wr      = round(wins / trades * 100) if trades else 0
            tier    = today.get("tier")
            date_s  = datetime.now(_TZ_THAI).strftime("%d %b %Y")
            target  = cfg.get("daily_target_thb", 3000)

            icon    = tier["icon"] if tier else ("✅" if pnl_thb >= target else "📊")
            status  = tier["label"] if tier else ("Mission Complete!" if pnl_thb >= target else "ยังไม่ถึงเป้า")

            msg = (
                f"{icon}  <b>POLIS Evening Report — {date_s}</b>\n\n"
                f"💰  P&L วันนี้:  <b>${pnl_usd:+.2f}</b>  "
                f"(<b>฿{pnl_thb:+,.0f}</b>)\n"
                f"🎯  เป้าหมาย:   ฿{target:,.0f}  →  <b>{status}</b>\n\n"
                f"📊  Trades: <b>{trades}</b>  ·  ✅ {wins}  ❌ {losses}  ·  WR <b>{wr}%</b>\n\n"
                f"🤖  <i>POLIS AI Trading OS</i>"
            )

            if self._tg:
                await self._tg.notify(msg)
                log.info("Evening report sent — P&L=$%.2f (฿%.0f)", pnl_usd, pnl_thb)

        except Exception as exc:
            log.warning("Evening report failed: %s", exc)

    async def _send(self) -> None:
        s = await self._db.yesterday_summary()
        if not s:
            log.warning("DailyBriefing: no data from DB")
            return

        date_str   = (datetime.now(_TZ_THAI) - timedelta(days=1)).strftime("%d %B %Y")
        total      = s["total"]
        approved   = s["approved"]
        blocked    = s["blocked"]
        rate       = s["approval_rate"]
        avg_conf   = s["avg_confidence"]
        max_conf   = s["max_confidence"]
        notional   = s["total_notional"]
        board      = s["board"]
        by_sym     = s.get("by_symbol", {})

        # Rating
        if rate >= 50:
            rating, color = "🟢 ดี", 0x10b981
        elif rate >= 30:
            rating, color = "🟡 ปานกลาง", 0xf59e0b
        else:
            rating, color = "🔴 ต่ำ", 0xef4444

        # Board summary
        board_lines = []
        for res in ["loosen", "hold", "tighten"]:
            cnt = board.get(res, 0)
            if cnt:
                icon = "🟢" if res == "loosen" else "⚪️" if res == "hold" else "🔴"
                board_lines.append(f"{icon} {res.upper()} × {cnt}")
        board_text = "\n".join(board_lines) if board_lines else "ไม่มีมติ"

        # Per-symbol breakdown
        sym_discord = ""
        sym_tg      = ""
        if by_sym:
            sym_lines = []
            for sym, d in by_sym.items():
                a_rate = round(d["approved"] / d["total"] * 100) if d["total"] else 0
                sym_lines.append(f"**{sym}** {d['total']} สัญญาณ · ✅{d['approved']} 🚫{d['blocked']} ({a_rate}%)")
            sym_discord = "\n".join(sym_lines)
            sym_tg      = "\n".join(
                f"  • <b>{sym}</b>  {d['total']} signals  ✅{d['approved']} 🚫{d['blocked']}"
                f"  ({round(d['approved']/d['total']*100) if d['total'] else 0}%)"
                for sym, d in by_sym.items()
            )

        notional_fmt = f"${notional/1000:.1f}k" if notional >= 1000 else f"${notional:.0f}"

        # ── Discord ───────────────────────────────────────────────────────────
        if self._url:
            fields = [
                {
                    "name":   "📈 ภาพรวมการเทรด",
                    "value":  (
                        f"สัญญาณ: **{total}**\n"
                        f"อนุมัติ: **{approved}** ({rate}%) {rating}\n"
                        f"บล็อก: **{blocked}**"
                    ),
                    "inline": True,
                },
                {
                    "name":   "🎯 ประสิทธิภาพ",
                    "value":  (
                        f"ความเชื่อมั่นเฉลี่ย: **{avg_conf}%**\n"
                        f"ความเชื่อมั่นสูงสุด: **{max_conf}%**\n"
                        f"มูลค่าจำลองรวม: **{notional_fmt}**"
                    ),
                    "inline": True,
                },
                {
                    "name":   "🏛️ มติบอร์ด",
                    "value":  board_text,
                    "inline": False,
                },
            ]
            if sym_discord:
                fields.append({
                    "name":   "📌 แยกตามสินทรัพย์",
                    "value":  sym_discord,
                    "inline": False,
                })
            payload = {"embeds": [{
                "title":       f"📊  POLIS Daily Report — {date_str}",
                "description": "สรุปประจำวันจากระบบ AI Trading OS",
                "color":       color,
                "fields":      fields,
                "footer":      {"text": "POLIS · ส่งอัตโนมัติทุกเช้า 08:00 น."},
                "timestamp":   datetime.now(timezone.utc).isoformat(),
            }]}
            try:
                async with httpx.AsyncClient() as c:
                    r = await c.post(self._url, json=payload, timeout=10.0)
                    r.raise_for_status()
                log.info("DailyBriefing Discord sent — %s trades, rate=%.1f%%", total, rate)
            except Exception as exc:
                log.warning("DailyBriefing Discord failed: %s", exc)

        # ── Telegram ──────────────────────────────────────────────────────────
        if self._tg:
            sym_section = f"\n\n📌  <b>แยกตามสินทรัพย์:</b>\n{sym_tg}" if sym_tg else ""
            board_tg    = board_text.replace("**", "<b>").replace("**", "</b>")
            try:
                await self._tg.notify(
                    f"📊  <b>POLIS Daily Report — {date_str}</b>\n\n"
                    f"📈  <b>ภาพรวมการเทรด:</b>\n"
                    f"    ├  สัญญาณทั้งหมด  <b>{total}</b>\n"
                    f"    ├  อนุมัติ ✅      <b>{approved}</b>  ({rate}%)  {rating}\n"
                    f"    └  บล็อก 🚫       <b>{blocked}</b>\n\n"
                    f"🎯  <b>ประสิทธิภาพ:</b>\n"
                    f"    ├  ความเชื่อมั่นเฉลี่ย  <b>{avg_conf}%</b>\n"
                    f"    ├  ความเชื่อมั่นสูงสุด  <b>{max_conf}%</b>\n"
                    f"    └  มูลค่าจำลองรวม      <b>{notional_fmt}</b>\n\n"
                    f"🏛️  <b>มติบอร์ด:</b>  {board_tg}"
                    f"{sym_section}"
                )
                log.info("DailyBriefing Telegram sent")
            except Exception as exc:
                log.warning("DailyBriefing Telegram failed: %s", exc)
