"""Discord Webhook notifications — TRADE_APPROVED, BOARD_RESOLUTION, POLICY_ADJUSTED."""
import logging
import os

import httpx

log = logging.getLogger("kernel.discord")


class DiscordNotifier:
    def __init__(self, bus) -> None:
        self._url = os.getenv("DISCORD_WEBHOOK_URL", "")
        if not self._url:
            log.warning("DISCORD_WEBHOOK_URL not set — notifications disabled")
            return
        bus.subscribe("TRADE_APPROVED",   self._on_approved)
        bus.subscribe("SIGNAL_REJECTED",  self._on_rejected)
        bus.subscribe("BOARD_RESOLUTION", self._on_board)
        bus.subscribe("POLICY_ADJUSTED",  self._on_policy)
        log.info("DiscordNotifier ready — #polis-co")

    async def _post(self, payload: dict) -> None:
        try:
            async with httpx.AsyncClient() as c:
                r = await c.post(self._url, json=payload, timeout=5.0)
                r.raise_for_status()
        except Exception as exc:
            log.warning("Discord post failed: %s", exc)

    @staticmethod
    def _conf_bar(pct, width: int = 12) -> str:
        try:
            filled = max(0, min(width, round(int(pct) / 100 * width)))
        except (TypeError, ValueError):
            return "░" * width
        return "█" * filled + "░" * (width - filled)

    async def _on_approved(self, data: dict) -> None:
        direction  = str(data.get("direction", "")).upper()
        symbol     = data.get("symbol", "XAUUSD")
        price      = data.get("price")
        confidence = data.get("confidence", "?")
        reason     = data.get("reason", "")
        risk_usd   = data.get("risk_usd", 0)
        lots       = data.get("lots")
        notional   = data.get("notional_usd")
        dir_icon   = "📈" if direction == "LONG" else "📉"
        color      = 0x10b981 if direction == "LONG" else 0xef4444

        price_str   = f"${float(price):,.2f}"    if price   else "—"
        lots_str    = f"{float(lots):.2f} lots"  if lots    else "—"
        notional_str= f"${float(notional):,.0f}" if notional else "—"
        bar         = self._conf_bar(confidence)

        await self._post({"embeds": [{
            "title":       f"{dir_icon}  {direction}  ·  {symbol}",
            "description": f"```\n{reason[:300]}\n```",
            "color":       color,
            "fields": [
                {"name": "💰 Entry Price",    "value": price_str,    "inline": True},
                {"name": "📦 Lot Size",       "value": lots_str,     "inline": True},
                {"name": "💵 Notional",       "value": notional_str, "inline": True},
                {"name": "⚠️ Risk / Trade",   "value": f"${float(risk_usd):,.2f}", "inline": True},
                {"name": "📊 Confidence",     "value": f"`{bar}` **{confidence}%**", "inline": False},
            ],
            "footer": {"text": "POLIS AI · Trade Executed"},
            "timestamp": __import__("datetime").datetime.utcnow().isoformat(),
        }]})

    async def _on_rejected(self, data: dict) -> None:
        direction  = str(data.get("direction", "")).upper()
        symbol     = data.get("symbol", "XAUUSD")
        price      = data.get("price")
        reasons    = data.get("rejected_reasons", [])
        research   = data.get("research", {})
        confidence = research.get("confidence", "?")
        reason_text = "\n".join(f"▸  {r}" for r in reasons) or "—"

        await self._post({"embeds": [{
            "title":       f"🟡  Rejected  ·  {direction} {symbol}",
            "description": f"```\n{reason_text}\n```",
            "color":       0xf59e0b,
            "fields": [
                {"name": "💰 Price",      "value": f"${float(price):,.2f}" if price else "—", "inline": True},
                {"name": "📊 Confidence", "value": f"{confidence}%",                           "inline": True},
            ],
            "footer": {"text": "POLIS Signal Filter"},
        }]})

    async def _on_board(self, data: dict) -> None:
        resolution = data.get("resolution", "hold")
        if resolution == "hold":
            return

        directive  = data.get("directive", "")
        confidence = data.get("confidence", "?")
        metrics    = data.get("metrics", {})
        exec_views = data.get("exec_views", {})
        emoji      = "🔴" if resolution == "tighten" else "🟢"
        color      = 0xef4444 if resolution == "tighten" else 0x10b981
        bar        = self._conf_bar(confidence)

        vote_lines = "\n".join(
            f"**{role.upper()}** `{v.get('vote','?')}` — {v.get('assessment','')[:80]}"
            for role, v in exec_views.items()
        )

        await self._post({"embeds": [{
            "title":       f"{emoji}  Board Resolution  ·  {resolution.upper()}",
            "description": f"> {directive}",
            "color":       color,
            "fields": [
                {"name": "📊 CEO Confidence",  "value": f"`{bar}` **{confidence}%**", "inline": False},
                {"name": "📈 Approval Rate",   "value": f"{metrics.get('approval_rate','?')}%", "inline": True},
                {"name": "🔢 Trades Reviewed", "value": str(metrics.get("total","?")),           "inline": True},
                {"name": "🗳️ Board Votes",     "value": (vote_lines[:1020] + "…") if len(vote_lines) > 1024 else vote_lines or "—"},
            ],
            "footer": {"text": "POLIS Executive Board"},
            "timestamp": __import__("datetime").datetime.utcnow().isoformat(),
        }]})

    async def _on_policy(self, data: dict) -> None:
        resolution = data.get("resolution", "")
        old        = float(data.get("old_risk", 0))
        new        = float(data.get("new_risk", 0))
        directive  = data.get("directive", "")
        emoji      = "⬇️" if resolution == "tighten" else "⬆️"
        color      = 0xef4444 if resolution == "tighten" else 0x10b981
        direction  = "ลดลง" if resolution == "tighten" else "เพิ่มขึ้น"

        await self._post({"embeds": [{
            "title":       f"{emoji}  Policy Adjusted  ·  {resolution.upper()}",
            "description": f"> {directive}",
            "color":       color,
            "fields": [
                {"name": "⚙️ Risk เดิม",   "value": f"`{old*100:.2f}%`", "inline": True},
                {"name": "⚙️ Risk ใหม่",   "value": f"`{new*100:.2f}%`", "inline": True},
                {"name": "📌 ทิศทาง",       "value": direction,            "inline": True},
            ],
            "footer": {"text": "POLIS Policy Governor"},
        }]})
