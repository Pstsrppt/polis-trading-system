# Runbook — Agent down / runaway token use
1. Dashboard → Registry → filter status `down` / `High token`.
2. Kernel auto-publishes `HEALTH_TICK`; CFO caps budget if spend > daily cap.
3. Restart: `make logs` → identify → registry `fire()` + `spawn()` (auto-reloads skills).
4. If repeated: route to `playground/` for replay before re-deploying.
