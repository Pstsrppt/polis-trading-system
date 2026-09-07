#!/usr/bin/env python3
"""Validate .env before starting POLIS.

Usage:
    python tools/validate_env.py          # check .env in project root
    python tools/validate_env.py .env.prod
"""
import os
import sys
from pathlib import Path

# ── ANSI colours ──────────────────────────────────────────────────────────────
R  = "\033[91m"; G = "\033[92m"; Y = "\033[93m"
B  = "\033[94m"; W = "\033[97m"; D = "\033[2m";  X = "\033[0m"

# ── Variable definitions ───────────────────────────────────────────────────────
# (name, required, description, example)
VARS = [
    # --- infrastructure (auto-set by docker-compose, but check anyway) ---
    ("POSTGRES_URL",    True,  "PostgreSQL connection string",
     "postgresql://polis:polis@postgres:5432/polis"),
    ("REDIS_URL",       True,  "Redis connection string",
     "redis://redis:6379/0"),

    # --- LLM providers (at least one required) ---
    ("GEMINI_API_KEY",      False, "Google Gemini — used by ResearchAgent",   "AIza..."),
    ("GROQ_API_KEY",        False, "Groq Llama — fast inference fallback",    "gsk_..."),
    ("OPENROUTER_API_KEY",  False, "OpenRouter — multi-model routing",        "sk-or-..."),

    # --- market data ---
    ("TWELVE_DATA_API_KEY", False, "TwelveData — Gold/DXY live quotes",       "abc123"),

    # --- notifications ---
    ("TELEGRAM_BOT_TOKEN",  False, "Telegram bot token from @BotFather",      "123456:ABC..."),
    ("TELEGRAM_CHAT_ID",    False, "Your Telegram chat/group ID",             "-100123456"),
    ("DISCORD_WEBHOOK_URL", False, "Discord channel webhook URL",             "https://discord.com/api/webhooks/..."),

    # --- broker ---
    ("OANDA_API_KEY",       False, "OANDA v20 REST API key",                  "abc-def-ghi"),
    ("OANDA_ACCOUNT_ID",    False, "OANDA account number",                    "001-001-..."),
    ("OANDA_ENV",           False, "practice or live (default: practice)",    "practice"),
    ("OANDA_ENABLED",       False, "Set true to place real orders",           "false"),

    # --- signal source ---
    ("SIGNAL_SOURCE",       False, "mock | twelvedata | tradingview",         "mock"),
    ("TRADINGVIEW_WEBHOOK_SECRET", False, "TradingView webhook auth secret",  "mysecret"),

    # --- governance ---
    ("DAILY_BUDGET_USD",      False, "Max notional per day (default 620)",    "620"),
    ("MAX_RISK_PER_TRADE",    False, "Max risk fraction per trade (0.005)",   "0.005"),
    ("MIN_SIGNAL_CONFIDENCE", False, "Min AI confidence to approve (60)",     "60"),
    ("ACCOUNT_BALANCE_USD",   False, "Starting account balance for sizing",   "10000"),
]

LLM_KEYS = {"GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY"}


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()
    return env


def main() -> None:
    env_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".env")
    if not env_path.exists():
        print(f"\n{R}✗ {env_path} not found{X}")
        print(f"  {D}Copy .env.example → .env and fill in your values{X}\n")
        sys.exit(1)

    env = load_env(env_path)
    os.environ.update(env)

    errors:   list[str] = []
    warnings: list[str] = []
    ok:       list[str] = []

    for name, required, desc, example in VARS:
        val = env.get(name, "").strip()
        if val:
            ok.append(name)
        elif required:
            errors.append((name, desc, example))
        else:
            warnings.append((name, desc, example))

    # Check: at least one LLM key set
    if not any(k in ok for k in LLM_KEYS):
        errors.append(("LLM_KEY", "At least one LLM key required (GEMINI / GROQ / OPENROUTER)", ""))

    # ── Print report ──────────────────────────────────────────────────────────
    print(f"\n{W}{'━'*56}{X}")
    print(f"  {B}POLIS — Environment Validation{X}  {D}{env_path}{X}")
    print(f"{'━'*56}{X}\n")

    if ok:
        print(f"{G}✓ Configured ({len(ok)}){X}")
        for name in ok:
            print(f"  {G}✓{X} {name}")
        print()

    if warnings:
        print(f"{Y}⚠ Optional / not set ({len(warnings)}){X}")
        for item in warnings:
            name, desc, example = item
            print(f"  {Y}–{X} {name:<32} {D}{desc}{X}")
            if example:
                print(f"    {D}example: {name}={example}{X}")
        print()

    if errors:
        print(f"{R}✗ Missing required ({len(errors)}){X}")
        for item in errors:
            name, desc, example = item
            print(f"  {R}✗{X} {name:<32} {desc}")
            if example:
                print(f"    {D}example: {name}={example}{X}")
        print()
        print(f"{R}Fix the above errors then re-run.{X}\n")
        sys.exit(1)
    else:
        score = len(ok) / (len(ok) + len(warnings)) * 100 if (ok or warnings) else 0
        print(f"{G}✓ All required vars set — ready to launch!{X}")
        print(f"  {D}Optional coverage: {score:.0f}% ({len(ok)}/{len(ok)+len(warnings)} vars configured){X}")
        print(f"\n  {D}Start system:  docker compose up --build -d{X}")
        print(f"  {D}View logs:     docker compose logs -f kernel gateway{X}")
        print(f"  {D}Stop system:   docker compose down{X}\n")


if __name__ == "__main__":
    main()
