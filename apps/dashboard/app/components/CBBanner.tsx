"use client";
import { useEffect, useState } from "react";

const GW   = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";
const GWWS = process.env.NEXT_PUBLIC_GATEWAY_WS  ?? "ws://localhost:19000/ws/feed";

type CbStatus = { triggered: boolean; reason: string; triggered_at: string | null };

export default function CBBanner() {
  const [cb,        setCb]        = useState<CbStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [blink,     setBlink]     = useState(false);

  useEffect(() => {
    const load = () =>
      fetch(`${GW}/circuit-breaker`)
        .then(r => r.json())
        .then((d: CbStatus) => {
          setCb(d);
          if (d.triggered) { setDismissed(false); setBlink(true); }
        })
        .catch(() => {});

    load();
    const poll = setInterval(load, 15_000);

    // WebSocket — instant update on trigger/reset
    let ws: WebSocket;
    const connect = () => {
      ws = new WebSocket(GWWS);
      ws.onmessage = ({ data }) => {
        try {
          const ev = JSON.parse(data);
          if (ev?.topic === "CIRCUIT_BREAKER_TRIGGERED") { load(); }
          if (ev?.topic === "CIRCUIT_BREAKER_RESET")     { load(); setDismissed(false); }
        } catch { /* ignore */ }
      };
      ws.onclose = () => setTimeout(connect, 5000);
      ws.onerror = () => ws.close();
    };
    connect();

    return () => { clearInterval(poll); ws?.close(); };
  }, []);

  // Blink animation — 3 pulses then stop
  useEffect(() => {
    if (!blink) return;
    const t = setTimeout(() => setBlink(false), 3000);
    return () => clearTimeout(t);
  }, [blink]);

  if (!cb?.triggered || dismissed) return null;

  const ts = cb.triggered_at
    ? new Date(cb.triggered_at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div style={{
      position:   "fixed",
      top:        0,
      left:       0,
      right:      0,
      zIndex:     9999,
      background: blink
        ? "linear-gradient(90deg,#7f1d1d,#991b1b,#7f1d1d)"
        : "linear-gradient(90deg,#450a0a,#7f1d1d,#450a0a)",
      borderBottom: "2px solid #ef4444",
      padding:    "10px 20px",
      display:    "flex",
      alignItems: "center",
      gap:        16,
      animation:  blink ? "cbPulse 0.6s ease-in-out 3" : undefined,
      boxShadow:  "0 4px 24px rgba(239,68,68,0.4)",
    }}>
      {/* Icon */}
      <div style={{
        width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
        background: "#ef4444", display: "flex", alignItems: "center",
        justifyContent: "center", fontSize: 16,
        animation: "ping 1.4s ease infinite",
      }}>🚨</div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 900, color: "#fca5a5", letterSpacing: "0.08em" }}>
          ⛔ CIRCUIT BREAKER TRIGGERED{ts ? ` · ${ts}` : ""}
        </div>
        <div style={{ fontSize: 11, color: "#f87171", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
          {cb.reason || "Trading halted — send /resume via Telegram to re-enable"}
        </div>
      </div>

      {/* Action */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <a href="/trading/soc" style={{
          padding: "6px 14px", borderRadius: 8, fontSize: 11, fontWeight: 700,
          background: "rgba(239,68,68,0.2)", border: "1px solid rgba(239,68,68,0.5)",
          color: "#fca5a5", textDecoration: "none", letterSpacing: "0.04em",
        }}>
          View SOC →
        </a>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          style={{
            width: 28, height: 28, borderRadius: "50%", border: "1px solid rgba(239,68,68,0.4)",
            background: "rgba(239,68,68,0.1)", color: "#f87171", cursor: "pointer",
            fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >×</button>
      </div>
    </div>
  );
}
