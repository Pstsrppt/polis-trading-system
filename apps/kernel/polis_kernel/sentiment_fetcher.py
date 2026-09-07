"""Social & News Sentiment Fetcher — free, no API key required.

Sources:
  1. StockTwits public API — real-time trading sentiment ($XAUUSD, $EURUSD etc.)
  2. Yahoo Finance News     — latest headlines via yfinance

Both cached 15 min to avoid excessive requests.
"""
import asyncio
import logging
import time

import httpx

log = logging.getLogger("kernel.sentiment")

_CACHE: dict[str, tuple[float, str]] = {}   # symbol → (ts, summary)
_TTL = 900   # 15 min

_STOCKTWITS_MAP: dict[str, str] = {
    "XAUUSD": "XAUUSD",
    "XAGUSD": "XAGUSD",
    "EURUSD": "EURUSD",
    "GBPUSD": "GBPUSD",
    "BTCUSD": "BTC.X",
}

_YF_MAP: dict[str, str] = {
    "XAUUSD": "GC=F",
    "XAGUSD": "SI=F",
    "EURUSD": "EURUSD=X",
    "GBPUSD": "GBPUSD=X",
    "BTCUSD": "BTC-USD",
}


async def _stocktwits_sentiment(symbol: str) -> str:
    """Fetch StockTwits public stream — returns bullish/bearish ratio + top message."""
    st_sym = _STOCKTWITS_MAP.get(symbol)
    if not st_sym:
        return ""
    try:
        url = f"https://api.stocktwits.com/api/2/streams/symbol/{st_sym}.json"
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(url, headers={"User-Agent": "POLIS/1.0"})
        if r.status_code != 200:
            return ""
        data     = r.json()
        messages = data.get("messages", [])[:20]

        bulls = sum(1 for m in messages
                    if m.get("entities", {}).get("sentiment", {}).get("basic") == "Bullish")
        bears = sum(1 for m in messages
                    if m.get("entities", {}).get("sentiment", {}).get("basic") == "Bearish")
        total = bulls + bears
        if total == 0:
            return ""

        bull_pct = round(bulls / total * 100)
        bias     = "bullish" if bull_pct > 55 else ("bearish" if bull_pct < 45 else "neutral")

        # Top message body (trimmed)
        top_msg = ""
        if messages:
            body = messages[0].get("body", "")
            top_msg = f' — top post: "{body[:80]}…"' if len(body) > 80 else f' — "{body}"'

        return (
            f"StockTwits ${st_sym}: {bull_pct}% bullish / {100-bull_pct}% bearish "
            f"({total} recent posts) → <b>{bias}</b>{top_msg}"
        )
    except Exception as exc:
        log.debug("StockTwits %s failed: %s", symbol, exc)
        return ""


async def _yf_news_sentiment(symbol: str) -> str:
    """Fetch Yahoo Finance news headlines via yfinance."""
    yf_sym = _YF_MAP.get(symbol)
    if not yf_sym:
        return ""
    try:
        import yfinance as yf  # noqa: PLC0415
        loop = asyncio.get_event_loop()
        ticker = await loop.run_in_executor(None, lambda: yf.Ticker(yf_sym))
        news   = await loop.run_in_executor(None, lambda: ticker.news or [])
        if not news:
            return ""

        headlines = []
        for item in news[:4]:
            title = item.get("title", "")
            if title:
                headlines.append(f"• {title}")

        return "Recent news:\n" + "\n".join(headlines) if headlines else ""
    except Exception as exc:
        log.debug("YF news %s failed: %s", symbol, exc)
        return ""


async def get_social_sentiment(symbol: str) -> str:
    """Return combined social + news sentiment summary. Cached 15 min."""
    now = time.monotonic()
    cached = _CACHE.get(symbol)
    if cached and now - cached[0] < _TTL:
        return cached[1]

    # Fetch both in parallel
    st_task  = _stocktwits_sentiment(symbol)
    yf_task  = _yf_news_sentiment(symbol)
    st, yf   = await asyncio.gather(st_task, yf_task, return_exceptions=True)

    parts = []
    if isinstance(st, str) and st:
        parts.append(st)
    if isinstance(yf, str) and yf:
        parts.append(yf)

    result = "\n".join(parts)
    _CACHE[symbol] = (now, result)

    if result:
        log.info("Sentiment [%s]: %d chars fetched", symbol, len(result))
    return result
