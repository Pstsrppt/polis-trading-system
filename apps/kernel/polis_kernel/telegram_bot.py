"""Telegram bot — POLIS command interface via phone."""
import json
import logging
import os

import redis.asyncio as aioredis

log = logging.getLogger("kernel.telegram")

_REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")

_TOKEN          = os.getenv("TELEGRAM_BOT_TOKEN", "")
_CHAT_ID        = int(os.getenv("TELEGRAM_CHAT_ID", "0"))
_SIGNAL_CHANNEL = os.getenv("SIGNAL_CHANNEL_ID", "")  # paid channel ID e.g. -1001234567890
_DIV            = "\n\n━━━━━━━━━━━━━━━━━━━━━━\n\n"


def _fp(v: float) -> str:
    if v < 10:   return f"${v:.5g}"
    if v < 1000: return f"${v:,.2f}"
    return f"${v:,.0f}"

def _bar(pct: int, width: int = 10) -> str:
    filled = max(0, min(width, round(pct / 100 * width)))
    return "█" * filled + "░" * (width - filled)


class TelegramBot:
    def __init__(self, bus, policy, db_module) -> None:
        self._bus     = bus
        self._policy  = policy
        self._db      = db_module
        self._paused  = False
        self._app     = None
        self._cb      = None

        if not _TOKEN:
            log.info("TelegramBot disabled — TELEGRAM_BOT_TOKEN not set")
            return

        try:
            from telegram.ext import Application, CommandHandler
            self._app = Application.builder().token(_TOKEN).build()
            self._app.add_handler(CommandHandler("start",     self._cmd_start))
            self._app.add_handler(CommandHandler("status",    self._cmd_status))
            self._app.add_handler(CommandHandler("pause",     self._cmd_pause))
            self._app.add_handler(CommandHandler("resume",    self._cmd_resume))
            self._app.add_handler(CommandHandler("risk",      self._cmd_risk))
            self._app.add_handler(CommandHandler("decisions", self._cmd_decisions))
            self._app.add_handler(CommandHandler("board",     self._cmd_board))
            self._app.add_handler(CommandHandler("cb",        self._cmd_cb))
            self._app.add_handler(CommandHandler("report",    self._cmd_report))
            self._app.add_handler(CommandHandler("world",     self._cmd_world))
            self._app.add_handler(CommandHandler("addsub",    self._cmd_addsub))
            self._app.add_handler(CommandHandler("delsub",    self._cmd_delsub))
            self._app.add_handler(CommandHandler("subs",      self._cmd_subs))
            self._app.add_handler(CommandHandler("approve",   self._cmd_approve))
            self._app.add_handler(CommandHandler("rejectsub", self._cmd_rejectsub))
            log.info("TelegramBot ready")
        except ImportError:
            log.warning("python-telegram-bot not installed — bot disabled")

        bus.subscribe("TRADE_APPROVED",     self._on_approved)
        bus.subscribe("BOARD_RESOLUTION",  self._on_board)
        bus.subscribe("POLICY_BLOCKED",    self._on_blocked)
        bus.subscribe("SIGNAL_REJECTED",   self._on_rejected)
        bus.subscribe("SUBSCRIBE_REQUEST", self._on_sub_request)
        bus.subscribe("SUBSCRIBE_APPROVED",self._on_sub_approved)

    def set_circuit_breaker(self, cb) -> None:
        self._cb = cb

    def is_paused(self) -> bool:
        return self._paused

    async def run(self) -> None:
        if not self._app:
            return
        await self._app.initialize()
        await self._app.start()
        await self._app.updater.start_polling(drop_pending_updates=True)
        log.info("TelegramBot polling started")
        import asyncio
        while True:
            await asyncio.sleep(3600)

    async def notify(self, text: str) -> None:
        if not self._app or not _CHAT_ID:
            return
        try:
            await self._app.bot.send_message(chat_id=_CHAT_ID, text=text, parse_mode="HTML")
        except Exception as exc:
            log.warning("Telegram send failed: %s", exc)

    async def broadcast_signal(self, text: str) -> int:
        """Send signal to paid channel. Returns number of chats reached."""
        if not self._app:
            return 0
        sent = 0
        # Send to signal channel if configured
        if _SIGNAL_CHANNEL:
            try:
                await self._app.bot.send_message(
                    chat_id=int(_SIGNAL_CHANNEL), text=text, parse_mode="HTML"
                )
                sent += 1
                log.info("Signal broadcast → channel %s", _SIGNAL_CHANNEL)
            except Exception as exc:
                log.warning("Signal channel broadcast failed: %s", exc)
        # Always also notify owner
        if _CHAT_ID:
            try:
                await self._app.bot.send_message(chat_id=_CHAT_ID, text=text, parse_mode="HTML")
                sent += 1
            except Exception as exc:
                log.warning("Signal owner notify failed: %s", exc)
        return sent

    # ── push notifications ────────────────────────────────────────
    async def _on_approved(self, data: dict) -> None:
        direction = str(data.get("direction", "")).upper()
        symbol    = data.get("symbol", "XAUUSD")
        price     = float(data.get("price", 0))
        lots      = float(data.get("lots", 0))
        conf      = int(data.get("confidence", 0))
        notional  = float(data.get("notional_usd", 0))
        risk_usd  = float(data.get("risk_usd", 0))
        stop      = float(data.get("stop", 0))
        dir_icon  = "📈" if direction == "LONG" else "📉"
        dir_label = "🟢 <b>LONG</b>" if direction == "LONG" else "🔴 <b>SHORT</b>"

        # ── Owner notification ────────────────────────────────────────
        await self.notify(
            f"<b>╔══ POLIS · TRADE EXECUTED ══╗</b>\n\n"
            f"{dir_icon}  {dir_label}  <code>{symbol}</code>\n\n"
            f"<code>"
            f"  Entry      {_fp(price)}\n"
            f"  Lots       {lots:.2f}\n"
            f"  Notional   ${notional:,.0f}\n"
            f"  Risk       ${risk_usd:,.2f}"
            f"</code>\n\n"
            f"📊  {_bar(conf)}  <b>{conf}%</b> confidence\n\n"
            f"<b>╚════════════════════════════╝</b>"
        )

        # ── Signal broadcast to paid channel ─────────────────────────
        if _SIGNAL_CHANNEL:
            tp_pct   = 2.0
            tp_price = round(
                (price + stop * tp_pct) if direction == "LONG"
                else (price - stop * tp_pct), 5
            )
            sl_price = round(
                (price - stop) if direction == "LONG"
                else (price + stop), 5
            )
            tp_pct_str = f"+{stop*tp_pct/price*100:.2f}%" if price else ""
            sl_pct_str = f"-{stop/price*100:.2f}%"        if price else ""
            signal_msg = (
                f"🔔  <b>POLIS AI SIGNAL</b>\n"
                f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
                f"{dir_icon}  <b>{direction}  {symbol}</b>\n\n"
                f"<code>"
                f"  💰 Entry    {_fp(price)}\n"
                f"  🎯 TP       {_fp(tp_price)}   {tp_pct_str}\n"
                f"  🛑 SL       {_fp(sl_price)}   {sl_pct_str}"
                f"</code>\n\n"
                f"📊  {_bar(conf)}  <b>{conf}%</b>\n"
                f"⚡  RR  <b>1 : {tp_pct:.1f}</b>   💵  Risk  <b>${risk_usd:,.2f}</b>\n\n"
                f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
                f"🤖  <i>POLIS AI · Automated Signal</i>"
            )
            await self.broadcast_signal(signal_msg)

    async def _on_board(self, data: dict) -> None:
        res       = str(data.get("resolution", "")).upper()
        icon      = "🔴" if res == "TIGHTEN" else "🟢" if res == "LOOSEN" else "⚪️"
        res_label = "เข้มงวดขึ้น 🔒" if res == "TIGHTEN" else "ผ่อนคลายลง 🔓" if res == "LOOSEN" else "คงเดิม ⏸"
        directive = data.get("directive", "")
        conf      = data.get("confidence", "?")
        await self.notify(
            f"{icon}  <b>มติคณะกรรมการ POLIS</b>\n"
            f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
            f"📌  การตัดสินใจ:  <b>{res_label}</b>\n\n"
            f"📋  <i>{directive}</i>\n\n"
            f"🎯  ความเชื่อมั่น  <b>{conf}%</b>\n"
            f"━━━━━━━━━━━━━━━━━━━━━━━━━━"
        )

    async def _on_blocked(self, data: dict) -> None:
        reason = str(data.get("reason", ""))
        if "trading hours" in reason or "paused" in reason.lower():
            return
        symbol    = data.get("symbol", "?")
        direction = str(data.get("direction", "")).upper()
        conf      = data.get("llm_confidence")
        conf_line = f"\n📊  Confidence  <b>{conf}%</b>" if conf is not None else ""
        dir_icon  = "📈" if direction == "LONG" else "📉"
        await self.notify(
            f"🚫  <b>สัญญาณถูกบล็อก</b>\n\n"
            f"{dir_icon}  <b>{direction} {symbol}</b>{conf_line}\n\n"
            f"<code>⚠️  {reason}</code>"
        )

    async def _on_rejected(self, data: dict) -> None:
        reasons: list[str] = data.get("rejected_reasons", [])
        if not reasons or all("trading hours" in r for r in reasons):
            return
        symbol    = data.get("symbol", "?")
        direction = str(data.get("direction", "")).upper()
        dir_icon  = "📈" if direction == "LONG" else "📉"
        reason_lines = "\n".join(f"  • {r}" for r in reasons)
        await self.notify(
            f"⛔  <b>Signal Rejected</b>\n\n"
            f"{dir_icon}  <b>{direction} {symbol}</b>\n\n"
            f"<code>{reason_lines}</code>"
        )

    # ── guard ─────────────────────────────────────────────────────
    def _allowed(self, update) -> bool:
        if not _CHAT_ID:
            return True
        return update.effective_chat.id == _CHAT_ID

    # ── commands ──────────────────────────────────────────────────
    async def _cmd_start(self, update, ctx) -> None:
        if not self._allowed(update): return
        await update.message.reply_text(
            "🤖  <b>POLIS — ศูนย์ควบคุม</b>\n"
            "<i>AI Enterprise Operating System</i>\n\n"
            "📋  <b>คำสั่งที่ใช้ได้:</b>\n"
            "  ⚡ /status      สถานะระบบแบบเรียลไทม์\n"
            "  ⏸  /pause       หยุดรับสัญญาณเทรด\n"
            "  ▶️  /resume      เปิดรับสัญญาณใหม่\n"
            "  ⚠️  /risk        ดู / ปรับความเสี่ยง\n"
            "  📊 /decisions   5 รายการตัดสินใจล่าสุด\n"
            "  🏛  /board       มติบอร์ดล่าสุด\n"
            "  📈 /report      รายงาน P&L ทั้งหมด\n"
            "  🌍 /world       สภาพตลาด macro ตอนนี้\n"
            "  💎 /addsub [id] [username] [days]  เพิ่ม subscriber\n"
            "  ❌ /delsub [id]  ยกเลิก subscriber\n"
            "  👥 /subs  ดูรายชื่อ subscribers"
            f"{_DIV}"
            "🤖  <b>POLIS — Command Center</b>\n"
            "<i>AI Enterprise Operating System</i>\n\n"
            "📋  <b>Available Commands:</b>\n"
            "  ⚡ /status      Real-time system status\n"
            "  ⏸  /pause       Pause trading signals\n"
            "  ▶️  /resume      Resume trading signals\n"
            "  ⚠️  /risk        View / adjust risk level\n"
            "  📊 /decisions   Last 5 trade decisions\n"
            "  🏛  /board       Latest board resolution\n"
            "  📈 /report      Full P&L report\n"
            "  🌍 /world       Live macro market snapshot",
            parse_mode="HTML",
        )

    async def _cmd_status(self, update, ctx) -> None:
        if not self._allowed(update): return
        metrics  = await self._db.recent_metrics(minutes=60)
        state_th = "⏸  หยุดชั่วคราว" if self._paused else "▶️  ทำงานอยู่"
        state_en = "⏸  PAUSED"        if self._paused else "▶️  RUNNING"
        total    = metrics["total"]
        approved = metrics["approved"]
        blocked  = metrics["blocked"]
        rate     = metrics["approval_rate"]
        conf     = metrics["avg_confidence"]
        risk_pct = f"{self._policy.max_risk*100:.2f}%"

        # Per-symbol breakdown
        by_sym = metrics.get("by_symbol", {})
        sym_lines_th = ""
        sym_lines_en = ""
        if by_sym:
            sym_lines_th = "\n\n📌  <b>แยกตามสินทรัพย์:</b>\n"
            sym_lines_en = "\n\n📌  <b>By Symbol:</b>\n"
            for sym, s in by_sym.items():
                a_rate = round(s["approved"] / s["total"] * 100) if s["total"] else 0
                sym_lines_th += f"    •  <b>{sym}</b>  {s['total']} สัญญาณ  ✅{s['approved']} 🚫{s['blocked']}  ({a_rate}%)\n"
                sym_lines_en += f"    •  <b>{sym}</b>  {s['total']} signals  ✅{s['approved']} 🚫{s['blocked']}  ({a_rate}%)\n"

        conf_int = int(conf) if str(conf).isdigit() else 0
        await update.message.reply_text(
            f"<b>🤖 POLIS · System Status</b>\n"
            f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
            f"{state_th}   ⚙️  Risk  <b>{risk_pct}</b>\n\n"
            f"<code>"
            f"  📊 สัญญาณ 1 ชม.     {total}\n"
            f"  ✅ อนุมัติ           {approved}\n"
            f"  🚫 บล็อก             {blocked}\n"
            f"  📈 อัตราอนุมัติ      {rate}%"
            f"</code>\n\n"
            f"🧠  ความเชื่อมั่นเฉลี่ย\n"
            f"  {_bar(conf_int)}  <b>{conf}%</b>"
            f"{sym_lines_th}\n"
            f"━━━━━━━━━━━━━━━━━━━━━━━━━━",
            parse_mode="HTML",
        )

    async def _cmd_pause(self, update, ctx) -> None:
        if not self._allowed(update): return
        self._paused = True
        log.info("POLIS paused via Telegram by chat_id=%s", update.effective_chat.id)
        await update.message.reply_text(
            "⏸  <b>POLIS หยุดทำงานแล้ว</b>\n\n"
            "🔕  ระบบจะไม่รับสัญญาณใหม่\n"
            "    จนกว่าจะสั่ง /resume"
            f"{_DIV}"
            "⏸  <b>POLIS Paused</b>\n\n"
            "🔕  No new signals will be processed\n"
            "    until you send /resume",
            parse_mode="HTML",
        )

    async def _cmd_resume(self, update, ctx) -> None:
        if not self._allowed(update): return
        self._paused = False
        if self._cb:
            self._cb.reset()
        log.info("POLIS resumed via Telegram by chat_id=%s", update.effective_chat.id)
        await update.message.reply_text(
            "▶️  <b>POLIS กลับมาทำงานแล้ว</b>\n\n"
            "🔔  ระบบรับสัญญาณตามปกติ\n"
            "🔓  Circuit Breaker รีเซ็ตแล้ว"
            f"{_DIV}"
            "▶️  <b>POLIS Resumed</b>\n\n"
            "🔔  Signal processing is active again\n"
            "🔓  Circuit Breaker has been reset",
            parse_mode="HTML",
        )

    async def _cmd_cb(self, update, ctx) -> None:
        if not self._allowed(update): return
        if not self._cb:
            await update.message.reply_text("ไม่มี Circuit Breaker / Circuit Breaker not available")
            return
        triggered = self._cb.is_triggered()
        consec    = self._cb._consec
        notional  = self._cb._day_notional
        budget    = float(os.getenv("DAILY_BUDGET_USD", "620"))
        icon      = "🔴" if triggered else "🟢"
        status_th = "เปิด — หยุดรับสัญญาณ" if triggered else "ปิด — ทำงานปกติ"
        status_en = "TRIGGERED — signals halted" if triggered else "OK — operating normally"
        await update.message.reply_text(
            f"{icon}  <b>Circuit Breaker</b>\n\n"
            f"สถานะ: <b>{status_th}</b>\n"
            f"Reject ติดต่อกัน: <b>{consec}</b> ครั้ง\n"
            f"งบวันนี้: <b>${notional:,.0f}</b> / ${budget:,.0f}\n"
            + (f"เหตุผล: {self._cb._reason}\n" if triggered else "")
            + (f"\nใช้ /resume เพื่อรีเซ็ต" if triggered else "")
            + f"{_DIV}"
            + f"{icon}  <b>Circuit Breaker</b>\n\n"
            f"Status: <b>{status_en}</b>\n"
            f"Consecutive rejects: <b>{consec}</b>\n"
            f"Daily notional: <b>${notional:,.0f}</b> / ${budget:,.0f}\n"
            + (f"Reason: {self._cb._reason}\n" if triggered else "")
            + (f"\nUse /resume to reset" if triggered else ""),
            parse_mode="HTML",
        )

    async def _cmd_risk(self, update, ctx) -> None:
        if not self._allowed(update): return
        args = ctx.args or []
        mode = args[0].lower() if args else ""
        if mode == "tight":
            new_risk = max(0.002, round(self._policy.max_risk * 0.7, 4))
            self._policy.max_risk = new_risk
            await update.message.reply_text(
                f"🔴  <b>ลดความเสี่ยงแล้ว</b>\n\n"
                f"⚙️  ความเสี่ยงสูงสุดใหม่\n"
                f"    └  <b>{new_risk*100:.2f}%</b>"
                f"{_DIV}"
                f"🔴  <b>Risk Tightened</b>\n\n"
                f"⚙️  New max risk\n"
                f"    └  <b>{new_risk*100:.2f}%</b>",
                parse_mode="HTML",
            )
        elif mode == "loose":
            new_risk = min(0.010, round(self._policy.max_risk * 1.3, 4))
            self._policy.max_risk = new_risk
            await update.message.reply_text(
                f"🟢  <b>เพิ่มความเสี่ยงแล้ว</b>\n\n"
                f"⚙️  ความเสี่ยงสูงสุดใหม่\n"
                f"    └  <b>{new_risk*100:.2f}%</b>"
                f"{_DIV}"
                f"🟢  <b>Risk Loosened</b>\n\n"
                f"⚙️  New max risk\n"
                f"    └  <b>{new_risk*100:.2f}%</b>",
                parse_mode="HTML",
            )
        else:
            risk_pct = f"{self._policy.max_risk*100:.2f}%"
            await update.message.reply_text(
                f"⚠️  <b>ความเสี่ยงปัจจุบัน</b>\n\n"
                f"⚙️  สูงสุดต่อออเดอร์  →  <b>{risk_pct}</b>\n\n"
                f"🔴  /risk tight   ลดลง 30%\n"
                f"🟢  /risk loose   เพิ่มขึ้น 30%"
                f"{_DIV}"
                f"⚠️  <b>Current Risk Settings</b>\n\n"
                f"⚙️  Max per trade  →  <b>{risk_pct}</b>\n\n"
                f"🔴  /risk tight   Reduce by 30%\n"
                f"🟢  /risk loose   Increase by 30%",
                parse_mode="HTML",
            )

    async def _cmd_decisions(self, update, ctx) -> None:
        if not self._allowed(update): return
        rows = await self._db.recent_decisions(limit=5)
        if not rows:
            await update.message.reply_text(
                "📭  ยังไม่มีข้อมูล\n\n━━━━━━━━━━━━━━━━━━━━━━\n\n📭  No data yet"
            )
            return
        th_lines = ["📊  <b>5 รายการตัดสินใจล่าสุด:</b>\n"]
        en_lines = ["📊  <b>Last 5 Decisions:</b>\n"]
        for d in rows:
            icon   = "✅" if d["outcome"] == "APPROVED" else "🚫"
            price  = _fp(float(d["price"])) if d.get("price") else "—"
            lots   = f"{float(d['lots']):.2f}L"   if d.get("lots")  else "—"
            conf   = d.get("confidence", "?")
            dir_up = str(d["direction"]).upper()
            dir_th = "ซื้อ 📈" if dir_up == "LONG" else "ขาย 📉"
            th_lines.append(
                f"{icon}  <b>{dir_th}</b>  {d['symbol']}\n"
                f"    ราคา {price}  ·  {lots}  ·  ความเชื่อมั่น {conf}%"
            )
            en_lines.append(
                f"{icon}  <b>{dir_up} 📈</b>  {d['symbol']}\n"
                f"    Price {price}  ·  {lots}  ·  Conf {conf}%"
            ) if dir_up == "LONG" else en_lines.append(
                f"{icon}  <b>{dir_up} 📉</b>  {d['symbol']}\n"
                f"    Price {price}  ·  {lots}  ·  Conf {conf}%"
            )
        await update.message.reply_text(
            "\n".join(th_lines) + _DIV + "\n".join(en_lines),
            parse_mode="HTML",
        )

    async def _cmd_board(self, update, ctx) -> None:
        if not self._allowed(update): return
        rows = await self._db.recent_resolutions(limit=1)
        if not rows:
            await update.message.reply_text(
                "📭  ยังไม่มีมติบอร์ด\n\n━━━━━━━━━━━━━━━━━━━━━━\n\n📭  No board resolution yet"
            )
            return
        r      = rows[0]
        res    = str(r["resolution"]).upper()
        icon   = "🔴" if res == "TIGHTEN" else "🟢" if res == "LOOSEN" else "⚪️"
        res_th = "เข้มงวดขึ้น" if res == "TIGHTEN" else "ผ่อนคลายลง" if res == "LOOSEN" else "คงเดิม"
        conf   = r.get("confidence", "?")
        await update.message.reply_text(
            f"🏛  <b>มติคณะกรรมการบริหาร</b>\n\n"
            f"{icon}  การตัดสินใจ:  <b>{res_th}</b>\n\n"
            f"📋  {r['directive']}\n\n"
            f"🎯  ความเชื่อมั่น:  <b>{conf}%</b>"
            f"{_DIV}"
            f"🏛  <b>Executive Board Resolution</b>\n\n"
            f"{icon}  Decision:  <b>{res}</b>\n\n"
            f"📋  {r['directive']}\n\n"
            f"🎯  Confidence:  <b>{conf}%</b>",
            parse_mode="HTML",
        )

    async def _cmd_report(self, update, ctx) -> None:
        if not self._allowed(update): return
        data = await self._db.closed_trade_report()
        if not data or data.get("all", {}).get("total", 0) == 0:
            await update.message.reply_text(
                "📭  ยังไม่มีเทรดที่ปิดแล้ว\n\n━━━━━━━━━━━━━━━━━━━━━━\n\n📭  No closed trades yet"
            )
            return

        a  = data["all"]
        td = data["today"]
        recent = data.get("recent", [])

        total      = int(a["total"])
        wins       = int(a["wins"])
        losses     = int(a["losses"])
        total_pnl  = float(a["total_pnl"])
        best       = float(a["best"])
        worst      = float(a["worst"])
        avg_win    = float(a["avg_win"])
        avg_loss   = float(a["avg_loss"])
        win_rate   = round(wins / total * 100, 1) if total else 0.0
        pnl_icon   = "🟢" if total_pnl >= 0 else "🔴"

        td_total = int(td["total"])
        td_wins  = int(td["wins"])
        td_pnl   = float(td["pnl"])
        td_pnl_icon = "🟢" if td_pnl >= 0 else "🔴"

        def _pnl(v: float) -> str:
            return f"+${v:,.2f}" if v >= 0 else f"-${abs(v):,.2f}"

        def _recent_line(r: dict) -> str:
            icon   = "✅" if r.get("trade_result") == "WIN" else "❌"
            sym    = r.get("symbol", "?")
            dir_   = str(r.get("direction", "")).upper()
            entry  = float(r["price"]) if r.get("price") else 0
            exit_  = float(r["exit_price"]) if r.get("exit_price") else 0
            pnl_v  = float(r["pnl_usd"]) if r.get("pnl_usd") else 0
            return (
                f"{icon}  <b>{dir_}</b> {sym}  "
                f"{_fp(entry)} → {_fp(exit_)}  <b>{_pnl(pnl_v)}</b>"
            )

        recent_th = "\n".join(_recent_line(r) for r in recent) or "—"
        recent_en = recent_th  # same format — symbols are universal

        await update.message.reply_text(
            f"📈  <b>รายงาน P&L — POLIS</b>\n\n"
            f"🗓  <b>วันนี้:</b>\n"
            f"    ├  ออเดอร์ปิด    <b>{td_total}</b>  (ชนะ <b>{td_wins}</b>)\n"
            f"    └  P&L วันนี้   {td_pnl_icon}  <b>{_pnl(td_pnl)}</b>\n\n"
            f"📊  <b>ทั้งหมด:</b>\n"
            f"    ├  ออเดอร์ทั้งหมด  <b>{total}</b>\n"
            f"    ├  ชนะ  ✅          <b>{wins}</b>    แพ้  ❌  <b>{losses}</b>\n"
            f"    ├  Win Rate        <b>{win_rate}%</b>\n"
            f"    ├  Total P&L       {pnl_icon}  <b>{_pnl(total_pnl)}</b>\n"
            f"    ├  ดีที่สุด         🔼  <b>{_pnl(best)}</b>\n"
            f"    ├  แย่ที่สุด        🔽  <b>{_pnl(worst)}</b>\n"
            f"    ├  Avg WIN         <b>{_pnl(avg_win)}</b>\n"
            f"    └  Avg LOSS        <b>{_pnl(avg_loss)}</b>\n\n"
            f"🕐  <b>5 ออเดอร์ล่าสุด:</b>\n{recent_th}"
            f"{_DIV}"
            f"📈  <b>P&L Report — POLIS</b>\n\n"
            f"🗓  <b>Today:</b>\n"
            f"    ├  Closed trades   <b>{td_total}</b>  (won <b>{td_wins}</b>)\n"
            f"    └  Today P&L       {td_pnl_icon}  <b>{_pnl(td_pnl)}</b>\n\n"
            f"📊  <b>All-Time:</b>\n"
            f"    ├  Total trades    <b>{total}</b>\n"
            f"    ├  Wins  ✅          <b>{wins}</b>    Losses  ❌  <b>{losses}</b>\n"
            f"    ├  Win Rate         <b>{win_rate}%</b>\n"
            f"    ├  Total P&L        {pnl_icon}  <b>{_pnl(total_pnl)}</b>\n"
            f"    ├  Best trade       🔼  <b>{_pnl(best)}</b>\n"
            f"    ├  Worst trade      🔽  <b>{_pnl(worst)}</b>\n"
            f"    ├  Avg WIN          <b>{_pnl(avg_win)}</b>\n"
            f"    └  Avg LOSS         <b>{_pnl(avg_loss)}</b>\n\n"
            f"🕐  <b>Last 5 Trades:</b>\n{recent_en}",
            parse_mode="HTML",
        )

    async def _on_sub_request(self, data: dict) -> None:
        """Notify admin of new subscription request."""
        req_id   = data.get("id", "?")
        username = data.get("username", "?")
        plan     = data.get("plan", "monthly")
        amount   = data.get("amount_thb", 0)
        slip     = data.get("slip_note", "")
        gw_url   = os.getenv("GATEWAY_URL", "http://gateway:8000")
        plan_label = {"monthly": "รายเดือน", "quarterly": "รายไตรมาส", "annual": "รายปี"}.get(plan, plan)

        await self.notify(
            f"💳  <b>คำขอสมัครใหม่!</b>\n"
            f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
            f"👤  @{username}\n"
            f"📦  แผน: <b>{plan_label}</b>\n"
            f"💰  ยอด: <b>฿{amount:,.0f}</b>\n"
            + (f"📝  หมายเหตุ: {slip}\n" if slip else "") +
            f"\n<code>/approve {req_id}</code>  ✅ อนุมัติ\n"
            f"<code>/rejectsub {req_id}</code> ❌ ปฏิเสธ\n\n"
            f"━━━━━━━━━━━━━━━━━━━━━━━━━━"
        )

    async def _on_sub_approved(self, data: dict) -> None:
        """Send channel invite to approved subscriber (if bot can message them)."""
        username    = data.get("username", "?")
        plan        = data.get("plan", "monthly")
        days        = data.get("days", 30)
        invite_link = data.get("invite_link", "")
        telegram_id = data.get("telegram_id")
        plan_label  = {"monthly": "รายเดือน", "quarterly": "รายไตรมาส", "annual": "รายปี"}.get(plan, plan)

        msg = (
            f"🎉  <b>ยินดีต้อนรับเข้า POLIS Signal!</b>\n\n"
            f"👤  @{username}\n"
            f"📦  แผน: <b>{plan_label}</b>  ({days} วัน)\n\n"
            + (f"🔗  เข้าร่วม channel ได้ที่:\n{invite_link}\n\n" if invite_link else "") +
            f"📡  คุณจะได้รับ signal ทุกครั้งที่ POLIS เทรดครับ\n"
            f"🤖  <i>POLIS AI Trading OS</i>"
        )
        # Send to subscriber directly if we have their telegram_id
        if telegram_id and self._app:
            try:
                await self._app.bot.send_message(
                    chat_id=int(telegram_id), text=msg, parse_mode="HTML"
                )
            except Exception:
                pass
        # Also notify admin
        await self.notify(f"✅  อนุมัติ @{username} ({plan_label}) แล้วครับ")

    async def _cmd_approve(self, update, ctx) -> None:
        """Admin: /approve <request_id>"""
        if not self._allowed(update): return
        args = ctx.args or []
        if not args:
            await update.message.reply_text("❌ Usage: /approve &lt;request_id&gt;", parse_mode="HTML")
            return
        req_id = args[0]
        gw_url = os.getenv("GATEWAY_URL", "http://gateway:8000")
        try:
            import httpx as _h  # noqa: PLC0415
            async with _h.AsyncClient(timeout=10.0) as client:
                r = await client.post(f"{gw_url}/signals/subscribe-request/{req_id}/approve")
                r.raise_for_status()
                result = r.json()
            await update.message.reply_text(
                f"✅  <b>อนุมัติแล้ว!</b>\n\n"
                f"👤  @{result.get('username','?')}\n"
                f"📦  {result.get('plan','?')}\n\n"
                f"subscriber ได้รับ invite link แล้วครับ",
                parse_mode="HTML"
            )
        except Exception as exc:
            await update.message.reply_text(f"❌ Error: {exc}")

    async def _cmd_rejectsub(self, update, ctx) -> None:
        """Admin: /rejectsub <request_id>"""
        if not self._allowed(update): return
        args = ctx.args or []
        if not args:
            await update.message.reply_text("❌ Usage: /rejectsub &lt;request_id&gt;", parse_mode="HTML")
            return
        req_id = args[0]
        gw_url = os.getenv("GATEWAY_URL", "http://gateway:8000")
        try:
            import httpx as _h  # noqa: PLC0415
            async with _h.AsyncClient(timeout=10.0) as client:
                r = await client.post(f"{gw_url}/signals/subscribe-request/{req_id}/reject")
                r.raise_for_status()
            await update.message.reply_text(f"❌ ปฏิเสธคำขอ #{req_id} แล้วครับ")
        except Exception as exc:
            await update.message.reply_text(f"❌ Error: {exc}")

    async def _cmd_addsub(self, update, ctx) -> None:
        """Admin: /addsub <telegram_id> <username> [days=30]"""
        if not self._allowed(update): return
        args = ctx.args or []
        if len(args) < 2:
            await update.message.reply_text(
                "❌ Usage: /addsub &lt;telegram_id&gt; &lt;username&gt; [days=30]",
                parse_mode="HTML"
            )
            return
        tg_id    = args[0]
        username = args[1].lstrip("@")
        days     = int(args[2]) if len(args) > 2 else 30
        gw_url   = os.getenv("GATEWAY_URL", "http://gateway:8000")
        try:
            import httpx as _h  # noqa: PLC0415
            async with _h.AsyncClient(timeout=10.0) as client:
                r = await client.post(
                    f"{gw_url}/signals/subscribers",
                    json={"telegram_id": int(tg_id), "username": username,
                          "days": days, "paid_amount": 0, "plan": "monthly"}
                )
                r.raise_for_status()
            await update.message.reply_text(
                f"✅  <b>เพิ่ม Subscriber แล้ว</b>\n\n"
                f"👤 @{username} (ID: {tg_id})\n"
                f"📅 ระยะเวลา: {days} วัน\n\n"
                f"ตอนนี้จะได้รับ signal alerts ทุกครั้งที่ POLIS เทรดครับ",
                parse_mode="HTML"
            )
        except Exception as exc:
            await update.message.reply_text(f"❌ Error: {exc}")

    async def _cmd_delsub(self, update, ctx) -> None:
        """Admin: /delsub <telegram_id>"""
        if not self._allowed(update): return
        args = ctx.args or []
        if not args:
            await update.message.reply_text("❌ Usage: /delsub &lt;telegram_id&gt;", parse_mode="HTML")
            return
        tg_id  = args[0]
        gw_url = os.getenv("GATEWAY_URL", "http://gateway:8000")
        try:
            import httpx as _h  # noqa: PLC0415
            async with _h.AsyncClient(timeout=10.0) as client:
                r = await client.delete(f"{gw_url}/signals/subscribers/{tg_id}")
                r.raise_for_status()
            await update.message.reply_text(
                f"✅  ยกเลิก Subscriber ID {tg_id} แล้ว",
                parse_mode="HTML"
            )
        except Exception as exc:
            await update.message.reply_text(f"❌ Error: {exc}")

    async def _cmd_subs(self, update, ctx) -> None:
        """Admin: /subs — list active subscribers + stats"""
        if not self._allowed(update): return
        gw_url = os.getenv("GATEWAY_URL", "http://gateway:8000")
        try:
            import httpx as _h  # noqa: PLC0415
            async with _h.AsyncClient(timeout=10.0) as client:
                stats_r = await client.get(f"{gw_url}/signals/stats")
                subs_r  = await client.get(f"{gw_url}/signals/subscribers")
            stats = stats_r.json()
            subs  = subs_r.json()
            active = [s for s in subs if s.get("status") == "active"]
            sub_lines = "\n".join(
                f"  • @{s.get('username','?')}  ({s.get('telegram_id')})"
                for s in active[:10]
            ) or "  ยังไม่มี subscriber"
            perf = stats.get("performance", {})
            mrr  = stats.get("subscribers", {}).get("mrr", 0)
            await update.message.reply_text(
                f"👥  <b>Signal Subscribers</b>\n\n"
                f"✅ Active: <b>{stats.get('subscribers',{}).get('active',0)}</b>\n"
                f"💰 MRR: <b>${mrr:,.0f}</b>\n\n"
                f"<b>รายชื่อ Active:</b>\n{sub_lines}\n\n"
                f"📊 <b>Performance:</b>\n"
                f"  สัญญาณทั้งหมด: {perf.get('total_signals',0)}\n"
                f"  Win/Loss: {perf.get('wins',0)}/{perf.get('losses',0)}  "
                f"({perf.get('win_rate',0)}%)\n"
                f"  P&L รวม: ${perf.get('total_pnl',0):+,.2f}",
                parse_mode="HTML"
            )
        except Exception as exc:
            await update.message.reply_text(f"❌ Error: {exc}")

    async def _cmd_world(self, update, ctx) -> None:
        if not self._allowed(update): return
        try:
            r   = aioredis.from_url(_REDIS_URL, socket_timeout=3.0)
            raw = await r.get("polis:world")
            await r.aclose()
        except Exception as exc:
            await update.message.reply_text(f"❌ Redis error: {exc}")
            return

        if not raw:
            await update.message.reply_text(
                "📭  ยังไม่มีข้อมูล World Model\n\n"
                "━━━━━━━━━━━━━━━━━━━━━━\n\n"
                "📭  World Model not ready yet"
            )
            return

        w = json.loads(raw)
        regime    = w.get("regime", "UNKNOWN")
        fg_val    = w.get("fg_value", "?")
        fg_cls    = w.get("fg_classification", "?")
        gold      = w.get("gold_price")
        gold_chg  = w.get("gold_chg_pct")
        eur       = w.get("eur_price")
        eur_chg   = w.get("eur_chg_pct")
        btc       = w.get("btc_price")
        btc_chg   = w.get("btc_chg_pct")
        dxy       = w.get("dxy_price")
        dxy_chg   = w.get("dxy_chg_pct")
        div       = w.get("gold_dxy_divergence")
        src       = w.get("_price_source", "?")
        ts        = w.get("ts", "")[:16].replace("T", " ")

        regime_icon = "🟢" if regime == "RISK-ON" else "🔴" if regime == "RISK-OFF" else "⚪️"
        fg_icon     = "😱" if isinstance(fg_val, int) and fg_val <= 25 else \
                      "😨" if isinstance(fg_val, int) and fg_val <= 45 else \
                      "😐" if isinstance(fg_val, int) and fg_val <= 55 else \
                      "😄" if isinstance(fg_val, int) and fg_val <= 75 else "🤩"

        def _chg(v) -> str:
            if v is None: return "—"
            return f"{v:+.2f}%"

        div_line = f"\n📐  Divergence  <b>{div:+.2f}%</b> ⚠️" if div and abs(div) >= 1.0 else ""

        await update.message.reply_text(
            f"🌍  <b>World Model Snapshot</b>\n"
            f"<i>{ts} UTC · src={src}</i>\n\n"
            f"{regime_icon}  Regime      <b>{regime}</b>\n"
            f"{fg_icon}  Fear&Greed  <b>{fg_val}/100</b>  ({fg_cls})\n\n"
            f"🥇  Gold    <b>{_fp(gold) if gold else '—'}</b>  {_chg(gold_chg)}\n"
            f"💶  EUR/USD <b>{_fp(eur)  if eur  else '—'}</b>  {_chg(eur_chg)}\n"
            f"🟠  BTC     <b>{_fp(btc)  if btc  else '—'}</b>  {_chg(btc_chg)}\n"
            f"💵  DXY     <b>{dxy:.2f}  {_chg(dxy_chg)}</b>"
            f"{div_line}",
            parse_mode="HTML",
        )
