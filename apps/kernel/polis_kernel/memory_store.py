"""Qdrant vector memory — stores trade decisions as feature vectors for similarity recall."""
import logging
import os
from datetime import datetime, timezone
from uuid import uuid4

from qdrant_client import AsyncQdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

log = logging.getLogger("kernel.memory")

COLLECTION = "trade_memory"
DIM        = 5   # [direction, risk, atr_spread_ratio, sentiment, regime]

_SENTIMENT = {"bullish": 1.0, "neutral": 0.0, "bearish": -1.0}
_REGIME    = {"trending": 1.0, "ranging": 0.5, "volatile": 0.0}


def _vec(direction: str, risk: float, atr: float, spread: float,
         sentiment: str, regime: str) -> list[float]:
    return [
        1.0 if direction == "long" else -1.0,
        min(float(risk) * 100, 1.0),                          # 0.5% → 0.5
        min(float(atr) / max(float(spread), 0.1) / 10, 1.0), # atr/spread, normalised
        _SENTIMENT.get(sentiment, 0.0),
        _REGIME.get(regime, 0.5),
    ]


class MemoryStore:
    def __init__(self) -> None:
        url = os.getenv("QDRANT_URL", "http://qdrant:6333")
        self._q     = AsyncQdrantClient(url=url)
        self._ready = False
        log.info("MemoryStore connecting to Qdrant @ %s", url)

    async def init(self) -> None:
        try:
            existing = {c.name for c in (await self._q.get_collections()).collections}
            if COLLECTION not in existing:
                await self._q.create_collection(
                    collection_name=COLLECTION,
                    vectors_config=VectorParams(size=DIM, distance=Distance.COSINE),
                )
                log.info("Qdrant collection '%s' created (dim=%d)", COLLECTION, DIM)
            else:
                count = (await self._q.count(COLLECTION)).count
                log.info("Qdrant collection '%s' ready (%d vectors)", COLLECTION, count)
            self._ready = True
        except Exception as exc:
            log.error("Qdrant init failed: %s — memory disabled", exc)

    async def store(self, direction: str, risk: float, atr: float, spread: float,
                    sentiment: str, regime: str, outcome: str,
                    confidence: int | None, reason: str, symbol: str,
                    price: float | None) -> None:
        if not self._ready:
            return
        try:
            await self._q.upsert(
                collection_name=COLLECTION,
                points=[PointStruct(
                    id=str(uuid4()),              # full UUID format required by Qdrant
                    vector=_vec(direction, risk, atr, spread, sentiment, regime),
                    payload={
                        "direction":  direction,
                        "sentiment":  sentiment,
                        "regime":     regime,
                        "outcome":    outcome,
                        "confidence": confidence,
                        "reason":     reason,
                        "risk":       risk,
                        "symbol":     symbol,
                        "price":      price,
                        "ts":         datetime.now(timezone.utc).isoformat(),
                    },
                )],
            )
            log.debug("Memory stored: %s %s/%s → %s", direction, sentiment, regime, outcome)
        except Exception as exc:
            log.warning("Memory store error: %s", exc)

    async def recall(self, direction: str, risk: float, atr: float, spread: float,
                     sentiment: str, regime: str, limit: int = 3,
                     symbol: str | None = None) -> list[dict]:
        if not self._ready:
            return []
        try:
            from qdrant_client.models import Filter, FieldCondition, MatchValue
            query_filter = (
                Filter(must=[FieldCondition(key="symbol", match=MatchValue(value=symbol))])
                if symbol else None
            )
            result = await self._q.query_points(
                collection_name=COLLECTION,
                query=_vec(direction, risk, atr, spread, sentiment, regime),
                limit=limit,
                score_threshold=0.65,
                query_filter=query_filter,
            )
            return [{"score": round(h.score, 2), **h.payload} for h in result.points]
        except Exception as exc:
            log.warning("Memory recall error: %s", exc)
            return []
