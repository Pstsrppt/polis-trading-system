"""POLIS Watchdog — runs on the host, alerts Discord + Telegram when any service goes down.

Run once in a separate terminal:
    python tools/watchdog.py

Polls /health/services every 60s. Sends ONE alert per outage (not every 60s spam).
Auto-recovers: sends "back up" notification when service comes back.
"""
import json
import logging
import os
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("watchdog")

GATEWAY_URL   = os.getenv("GATEWAY_URL", "http://localhost:19000")
POLL_INTERVAL = 60   # seconds
DISCORD_URL   = os.getenv("DISCORD_WEBHOOK_URL", "")
TG_TOKEN      = os.getenv("TELEGRAM_BOT_TOKEN", "")
TG_CHAT_ID    = os.getenv("TELEGRAM_CHAT_ID", "")

# Core infrastructure services — DOWN is a real outage
INFRA_SERVICES = {
    "gateway":  "Gateway API",
    "kernel":   "Kernel AI",
    "redis":    "Redis",
    "postgres": "Postgres",
    "qdrant":   "Qdrant (Memory)",
}

# Advisory services — "warn" means degraded, not outage
ADVISORY_SERVICES = {
    "world_model":     "World Model",
    "circuit_breaker": "Circuit Breaker",
}

REGIME_STRINGS = {"RISK-ON", "RISK-OFF", "NEUTRAL", "UNKNOWN"}

# Track state per service: None=unknown, "ok", "warn", "error"
_state: dict[str, str | None] = {
    **{k: None for k in INFRA_SERVICES},
    **{k: None for k in ADVISORY_SERVICES},
}


def _discord(payload: dict) -> None:
    if not DISCORD_URL:
        return
    try:
        requests.post(DISCORD_URL, json=payload, timeout=5)
    except Exception as exc:
        log.warning("Discord failed: %s", exc)


def _telegram(text: str) -> None:
    if not TG_TOKEN or not TG_CHAT_ID:
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json={"chat_id": TG_CHAT_ID, "text": text, "parse_mode": "HTML"},
            timeout=5,
        )
    except Exception as exc:
        log.warning("Telegram failed: %s", exc)


def _alert_down(service: str, raw: str) -> None:
    all_labels = {**INFRA_SERVICES, **ADVISORY_SERVICES}
    label = all_labels.get(service, service)

    if service == "circuit_breaker":
        # CB triggered is a soft alert — not a crash
        log.warning("CIRCUIT BREAKER TRIGGERED")
        _discord({"embeds": [{"title": "⚠️  Circuit Breaker Triggered",
            "description": "ระบบหยุดรับสัญญาณชั่วคราว ใช้ /resume เพื่อเปิดใหม่",
            "color": 0xf59e0b, "footer": {"text": "POLIS Watchdog"}}]})
        _telegram("⚠️  <b>Circuit Breaker Triggered</b>\nระบบหยุดรับสัญญาณ\nใช้ /resume เพื่อเปิดใหม่")
        return

    if service == "world_model":
        log.warning("WORLD MODEL: no data yet")
        return   # startup noise — don't alert

    log.warning("SERVICE DOWN: %s (status=%s)", label, raw)
    _discord({"embeds": [{"title": f"🔴  SERVICE DOWN — {label}",
        "description": f"`{service}` ไม่ตอบสนอง — ตรวจสอบ Docker",
        "color": 0xef4444,
        "fields": [{"name": "ระบบ", "value": label, "inline": True},
                   {"name": "Action", "value": f"`docker compose logs {service}`", "inline": True}],
        "footer": {"text": "POLIS Watchdog"}}]})
    _telegram(
        f"🔴  <b>SERVICE DOWN — {label}</b>\n\n"
        f"⛔ <code>{service}</code> ไม่ตอบสนอง\n"
        f"ตรวจสอบ: <code>docker compose logs {service}</code>\n\n"
        f"━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"🔴  <b>SERVICE DOWN — {label}</b>\n\n"
        f"Check: <code>docker compose logs {service}</code>"
    )


def _alert_up(service: str) -> None:
    all_labels = {**INFRA_SERVICES, **ADVISORY_SERVICES}
    label = all_labels.get(service, service)
    log.info("SERVICE RECOVERED: %s", label)

    if service == "circuit_breaker":
        _discord({"embeds": [{"title": "🟢  Circuit Breaker Reset",
            "description": "ระบบรับสัญญาณตามปกติ",
            "color": 0x10b981, "footer": {"text": "POLIS Watchdog"}}]})
        _telegram("🟢  <b>Circuit Breaker Reset</b>\nระบบรับสัญญาณตามปกติ")
        return

    _discord({"embeds": [{"title": f"🟢  SERVICE RECOVERED — {label}",
        "description": f"`{service}` กลับมาออนไลน์แล้ว",
        "color": 0x10b981, "footer": {"text": "POLIS Watchdog"}}]})
    _telegram(
        f"🟢  <b>SERVICE RECOVERED — {label}</b>\n\n"
        f"✅ <code>{service}</code> กลับมาออนไลน์แล้ว\n\n"
        f"━━━━━━━━━━━━━━━━━━━━━━\n\n"
        f"✅ <code>{service}</code> is back online"
    )


def _classify(service: str, raw: str) -> str:
    """Return 'ok', 'warn', or 'error' for a raw status value."""
    if raw == "ok":
        return "ok"
    if raw == "error":
        return "error"
    if service == "world_model" and raw in REGIME_STRINGS:
        return "ok"   # regime string means world model is healthy
    if service == "circuit_breaker" and raw == "warn":
        return "warn"   # CB triggered — not a crash but needs attention
    if raw == "warn":
        return "warn"
    return "error"


def _check() -> None:
    try:
        r = requests.get(f"{GATEWAY_URL}/health/services", timeout=5)
        statuses: dict[str, str] = r.json()
    except Exception:
        # Gateway itself is down — mark everything error
        statuses = {k: "error" for k in {**INFRA_SERVICES, **ADVISORY_SERVICES}}

    all_services = {**INFRA_SERVICES, **ADVISORY_SERVICES}
    for service in all_services:
        raw    = statuses.get(service, "error")
        status = _classify(service, raw)
        prev   = _state[service]

        if status in ("error", "warn") and prev not in ("error", "warn"):
            _state[service] = status
            _alert_down(service, raw)
        elif status == "ok" and prev in ("error", "warn"):
            _state[service] = "ok"
            _alert_up(service)
        else:
            _state[service] = status


def main() -> None:
    log.info("POLIS Watchdog started — polling every %ds", POLL_INTERVAL)
    log.info("Gateway: %s", GATEWAY_URL)
    log.info("Discord: %s", "enabled" if DISCORD_URL else "disabled")
    log.info("Telegram: %s", "enabled" if TG_TOKEN else "disabled")

    while True:
        try:
            _check()
        except Exception as exc:
            log.error("Watchdog error: %s", exc)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
