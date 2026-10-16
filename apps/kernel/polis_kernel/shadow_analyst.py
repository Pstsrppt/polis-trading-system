"""Shadow-test other models on the exact question the live model answered.

Whether a stronger model would help cannot be settled by switching to it — that
spends real money finding out. Instead, every time the research agent answers,
each challenger is sent the identical system prompt and user prompt, and every
answer (live model included) is written to model_calls with the price at the
time. Nothing here can place, block or alter a trade.

Scoring happens offline: join model_calls to the price N hours later and see
which model's bullish/bearish call was right more often, and whether its stated
confidence tracks how often it is right.
"""
import asyncio
import json
import logging
import os

import httpx
from polis_llm import JSON_ONLY, parse_json

from .research_agent import _SYSTEM

log = logging.getLogger("kernel.shadow")

# "provider:model" pairs. Different families from the live model on purpose:
# two models from the same family mostly tell you the same thing.
_DEFAULT = "gemini:gemini-flash-latest,groq:qwen/qwen3.8-27b"
_SHADOWS = [s.strip() for s in os.getenv("SHADOW_MODELS", _DEFAULT).split(",") if s.strip()]
_TIMEOUT = float(os.getenv("SHADOW_TIMEOUT_SECONDS", "25"))

_DDL = """
CREATE TABLE IF NOT EXISTS model_calls (
    id          SERIAL PRIMARY KEY,
    signal_ts   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    symbol      TEXT        NOT NULL,
    signal_dir  TEXT,
    price       NUMERIC,
    atr         NUMERIC,
    source      TEXT,
    role        TEXT        NOT NULL,   -- 'live' or 'shadow'
    model       TEXT        NOT NULL,
    sentiment   TEXT,
    confidence  INTEGER,
    regime      TEXT,
    ok          BOOLEAN     NOT NULL,
    error       TEXT,
    latency_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS model_calls_ts_idx ON model_calls (signal_ts);
"""


class ShadowAnalyst:
    def __init__(self, bus, db_module) -> None:
        self._db = db_module
        self._tasks: set = set()
        bus.subscribe("RESEARCH_COMPLETE", self._on_research)
        log.info("ShadowAnalyst online — challengers: %s", ", ".join(_SHADOWS) or "none")

    async def init(self) -> None:
        pool = self._db._pool
        if pool is None:
            return
        async with pool.acquire() as conn:
            await conn.execute(_DDL)

    async def _on_research(self, data: dict) -> None:
        prompt = data.get("prompt")
        if not prompt:
            return                       # older publisher, nothing to compare
        research = data.get("research") or {}
        base = {
            "symbol":     data.get("symbol"),
            "signal_dir": data.get("direction"),
            "price":      data.get("price"),
            "atr":        data.get("atr"),
            "source":     data.get("source"),
        }
        live_model = str(data.get("model") or "unknown")
        await self._record({
            **base, "role": "live", "model": live_model,
            "sentiment": research.get("sentiment"),
            "confidence": research.get("confidence"),
            "regime": research.get("regime"),
            "ok": not live_model.startswith("fallback"),
            "error": None, "latency_ms": None,
        })
        # Detached and referenced: a slow challenger must never hold up the live path.
        for spec in _SHADOWS:
            task = asyncio.create_task(self._ask(spec, prompt, base))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _ask(self, spec: str, prompt: str, base: dict) -> None:
        provider, _, model = spec.partition(":")
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        row = {**base, "role": "shadow", "model": spec,
               "sentiment": None, "confidence": None, "regime": None,
               "ok": False, "error": None, "latency_ms": None}
        try:
            raw = await asyncio.wait_for(self._call(provider, model, prompt), timeout=_TIMEOUT)
            out = parse_json(raw)
            row.update(sentiment=str(out.get("sentiment", "")).lower() or None,
                       confidence=int(out.get("confidence") or 0) or None,
                       regime=str(out.get("regime", "")).lower() or None,
                       ok=True)
        except Exception as exc:
            row["error"] = f"{type(exc).__name__}: {exc}"[:300]
        row["latency_ms"] = int((loop.time() - t0) * 1000)
        await self._record(row)

    async def _call(self, provider: str, model: str, prompt: str) -> str:
        system = _SYSTEM + JSON_ONLY
        if provider == "groq":
            from groq import AsyncGroq  # noqa: PLC0415
            client = AsyncGroq(api_key=os.environ.get("GROQ_API_KEY", ""), max_retries=0)
            resp = await client.chat.completions.create(
                model=model,
                messages=[{"role": "system", "content": system},
                          {"role": "user", "content": prompt}],
            )
            return resp.choices[0].message.content or ""
        if provider == "gemini":
            from google import genai  # noqa: PLC0415
            from google.genai import types  # noqa: PLC0415
            client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY", ""))
            resp = await client.aio.models.generate_content(
                model=model, contents=prompt,
                config=types.GenerateContentConfig(system_instruction=system),
            )
            return resp.text or ""
        if provider == "openrouter":
            async with httpx.AsyncClient() as client:
                r = await client.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers={"Authorization": f"Bearer {os.environ.get('OPENROUTER_API_KEY', '')}"},
                    json={"model": model,
                          "messages": [{"role": "system", "content": system},
                                       {"role": "user", "content": prompt}]},
                    timeout=_TIMEOUT,
                )
                r.raise_for_status()
                return r.json()["choices"][0]["message"]["content"] or ""
        raise ValueError(f"unknown provider {provider!r}")

    async def _record(self, row: dict) -> None:
        pool = self._db._pool
        if pool is None:
            return
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    """INSERT INTO model_calls
                       (symbol, signal_dir, price, atr, source, role, model,
                        sentiment, confidence, regime, ok, error, latency_ms)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)""",
                    row["symbol"], row["signal_dir"],
                    float(row["price"]) if row["price"] is not None else None,
                    float(row["atr"]) if row["atr"] is not None else None,
                    row["source"], row["role"], row["model"],
                    row["sentiment"], row["confidence"], row["regime"],
                    row["ok"], row["error"], row["latency_ms"],
                )
        except Exception as exc:
            log.warning("shadow: could not record %s: %s", row.get("model"), exc)
