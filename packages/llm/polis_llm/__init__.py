"""LLM abstraction — Groq → Gemini → OpenRouter auto-fallback chain.

Strategy:
  1. Try Groq Llama-3.3 (fast, generous free quota)
  2. On quota/error → try Gemini 2.0 Flash Lite
  3. On quota/error → OpenRouter (free tier, no daily limit)
"""
import json
import logging
import os

import httpx
from groq import AsyncGroq

log = logging.getLogger("polis.llm")

_GROQ_MODEL        = "llama-3.3-70b-versatile"
_GEMINI_MODEL      = "gemini-2.0-flash-lite"
_OPENROUTER_MODEL  = os.getenv("OPENROUTER_MODEL", "meta-llama/llama-4-scout:free")
_OPENROUTER_URL    = "https://openrouter.ai/api/v1/chat/completions"

_QUOTA_SIGNALS = ("429", "RESOURCE_EXHAUSTED", "quota", "rate_limit", "Too Many")


def _is_quota_error(exc: Exception) -> bool:
    msg = str(exc)
    return any(s in msg for s in _QUOTA_SIGNALS)


class LLMClient:
    def __init__(self, model: str = _GROQ_MODEL) -> None:
        self._groq   = AsyncGroq(api_key=os.environ.get("GROQ_API_KEY", ""), max_retries=0)
        self._gemini = None
        self.model   = model

    def _get_gemini(self):
        if self._gemini is None:
            from google import genai  # noqa: PLC0415
            self._gemini = genai.Client(api_key=os.environ.get("GEMINI_API_KEY", ""))
        return self._gemini

    async def complete(self, system: str, user: str) -> str:
        # ── 1. Groq (primary — fast, free, no daily quota) ────────────
        if os.environ.get("GROQ_API_KEY"):
            try:
                resp = await self._groq.chat.completions.create(
                    model=_GROQ_MODEL,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user",   "content": user},
                    ],
                )
                log.debug("Groq OK")
                return resp.choices[0].message.content or ""
            except Exception as exc:
                if not _is_quota_error(exc):
                    raise
                log.warning("Groq quota exceeded — switching to Gemini")

        # ── 2. Gemini fallback ─────────────────────────────────────────
        if os.environ.get("GEMINI_API_KEY"):
            try:
                from google.genai import types  # noqa: PLC0415
                gemini = self._get_gemini()
                resp = await gemini.aio.models.generate_content(
                    model=_GEMINI_MODEL,
                    contents=user,
                    config=types.GenerateContentConfig(system_instruction=system),
                )
                log.info("Gemini OK (Groq fallback)")
                return resp.text or ""
            except Exception as exc:
                if not _is_quota_error(exc):
                    raise
                log.warning("Gemini quota exceeded — switching to OpenRouter")

        # ── 3. OpenRouter fallback ─────────────────────────────────────
        openrouter_key = os.environ.get("OPENROUTER_API_KEY", "")
        if not openrouter_key:
            raise RuntimeError("All LLM providers quota exceeded")

        import asyncio as _asyncio  # noqa: PLC0415
        async with httpx.AsyncClient() as client:
            for attempt in range(4):
                r = await client.post(
                    _OPENROUTER_URL,
                    headers={
                        "Authorization": f"Bearer {openrouter_key}",
                        "HTTP-Referer":  "https://polis.ai",
                        "X-Title":       "POLIS Trading OS",
                    },
                    json={
                        "model":    _OPENROUTER_MODEL,
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user",   "content": user},
                        ],
                    },
                    timeout=30.0,
                )
                if r.status_code == 429:
                    wait = 2 ** attempt * 3
                    log.warning("OpenRouter 429 — retry %d/3 in %ds", attempt + 1, wait)
                    await _asyncio.sleep(wait)
                    continue
                r.raise_for_status()
                log.info("OpenRouter OK (tertiary fallback)")
                return r.json()["choices"][0]["message"]["content"] or ""
        raise RuntimeError("OpenRouter rate limit exceeded after retries")

    async def complete_json(self, system: str, user: str) -> dict:
        raw = await self.complete(
            system=system + "\n\nRespond with valid JSON only. No markdown fences.",
            user=user,
        )
        cleaned = (
            raw.strip()
            .removeprefix("```json")
            .removeprefix("```")
            .removesuffix("```")
            .strip()
        )
        return json.loads(cleaned)
