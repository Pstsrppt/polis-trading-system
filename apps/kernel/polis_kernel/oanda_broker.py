"""Oanda v20 REST — multi-symbol execution layer.

Set OANDA_ENABLED=true + OANDA_API_KEY + OANDA_ACCOUNT_ID to place real orders.
Default is SIMULATION mode (logs only, no real orders).
"""
import logging
import os

import httpx

log = logging.getLogger("kernel.oanda")

_OANDA_ENV  = os.getenv("OANDA_ENV", "practice")
_BASE_URL   = (
    "https://api-fxtrade.oanda.com"
    if _OANDA_ENV == "live"
    else "https://api-fxpractice.oanda.com"
)


class OandaBroker:
    def __init__(self) -> None:
        self._api_key    = os.environ.get("OANDA_API_KEY", "")
        self._account_id = os.environ.get("OANDA_ACCOUNT_ID", "")
        self._enabled    = (
            os.getenv("OANDA_ENABLED", "false").lower() == "true"
            and bool(self._api_key)
            and bool(self._account_id)
        )
        if self._enabled:
            log.info(
                "OandaBroker LIVE — %s  account=%s",
                _OANDA_ENV.upper(), self._account_id,
            )
        else:
            log.info(
                "OandaBroker SIMULATION — set OANDA_ENABLED=true to execute real orders"
            )

    @property
    def enabled(self) -> bool:
        return self._enabled

    async def place_order(
        self,
        direction: str,           # "long" | "short"
        lots: float,
        price: float,
        stop: float,              # stop distance (price delta)
        instrument: str = "XAU_USD",
        units_per_lot: int = 100, # contract size per lot
    ) -> dict:
        """Place a market order. Returns result dict with order_id and fill_price."""
        units = lots * units_per_lot
        if direction == "short":
            units = -units

        raw_stop = price - stop if direction == "long" else price + stop
        # OANDA requires 5 decimal places for FX pairs, 2 for metals/crypto
        stop_price = f"{raw_stop:.5f}" if price < 10 else f"{raw_stop:.2f}"

        payload = {
            "order": {
                "type":         "MARKET",
                "instrument":   instrument,
                "units":        str(round(units, 2)),
                "timeInForce":  "FOK",
                "positionFill": "DEFAULT",
                "stopLossOnFill": {
                    "price":       stop_price,
                    "timeInForce": "GTC",
                },
            }
        }

        if not self._enabled:
            log.info(
                "SIM %s %s  lots=%.2f  units=%.0f  stop=%s",
                direction.upper(), instrument, lots, abs(units), stop_price,
            )
            return {
                "simulated":  True,
                "order_id":   "SIM",
                "fill_price": price,
                "units":      units,
            }

        url = f"{_BASE_URL}/v3/accounts/{self._account_id}/orders"
        try:
            async with httpx.AsyncClient() as client:
                r = await client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type":  "application/json",
                    },
                    json=payload,
                    timeout=10.0,
                )
                r.raise_for_status()
            data = r.json()
            fill = data.get("orderFillTransaction", {})
            order_id   = fill.get("id") or data.get("relatedTransactionIDs", ["?"])[0]
            fill_price = float(fill.get("price") or price)
            log.info(
                "OANDA FILLED %s %s  order=%s  fill=%.2f  lots=%.2f",
                direction.upper(), instrument, order_id, fill_price, lots,
            )
            return {"order_id": order_id, "fill_price": fill_price, "units": units}
        except Exception as exc:
            log.error("Oanda order failed: %s", exc)
            return {"order_id": None, "fill_price": price, "units": units, "error": str(exc)}
