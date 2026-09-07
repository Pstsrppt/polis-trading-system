# Trading Division
H1 breakout · LONG_BIAS · RR 1:3 · bar-close-only entries. Connects to MT5 via
`integrations/`. Every order passes the Risk Agent, then the kernel Policy Engine
(`risk <= 0.5%`), then the Digital Twin before touching real money.

agents/ · mt5/ · strategy/ · backtest/ · indicators/
