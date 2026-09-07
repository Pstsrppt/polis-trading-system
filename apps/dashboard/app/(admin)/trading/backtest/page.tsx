"use client";
import { useState, useCallback } from "react";

const GW = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";

const ALL_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "BTCUSD", "XAGUSD"];

type Summary = {
  total: number; wins: number; losses: number; win_rate: number;
  sim_pnl: number; orig_pnl: number; pnl_delta: number;
  avg_win: number; avg_loss: number;
};
type SymRow = { symbol: string; win_rate: number; trades: number; sim_pnl: number };
type Result = { params: Record<string, unknown>; summary: Summary; by_symbol: SymRow[] };

function Chip({ label, active, color, onClick }: { label: string; active: boolean; color: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{
      padding: "5px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700,
      cursor: "pointer", border: `1.5px solid ${active ? color : "rgba(0,0,0,0.1)"}`,
      background: active ? `${color}18` : "#f8fafc", color: active ? color : "#64748b",
      transition: "all 0.15s",
    }}>{label}</button>
  );
}

export default function BacktestPage() {
  const [minConf,  setMinConf]  = useState(60);
  const [ratio,    setRatio]    = useState(3.0);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [result,   setResult]   = useState<Result | null>(null);
  const [loading,  setLoading]  = useState(false);

  const toggleSym = (s: string) =>
    setExcluded(p => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n; });

  const run = useCallback(async () => {
    setLoading(true); setResult(null);
    try {
      const q = new URLSearchParams({
        min_confidence:  String(minConf),
        reward_ratio:    String(ratio),
        exclude_symbols: [...excluded].join(","),
      });
      const r = await fetch(`${GW}/backtest?${q}`);
      setResult(await r.json());
    } catch { /* offline */ }
    finally { setLoading(false); }
  }, [minConf, ratio, excluded]);

  const s = result?.summary;
  const rr = s && s.avg_loss !== 0 ? Math.abs(s.avg_win / s.avg_loss).toFixed(2) : "—";
  const maxAbsPnl = result
    ? Math.max(...result.by_symbol.map(r => Math.abs(r.sim_pnl)), 1)
    : 1;

  return (
    <div style={{ padding: "28px 32px 60px", background: "#f8fafc", minHeight: "100vh" }}>

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.15em",
          textTransform: "uppercase", marginBottom: 6 }}>POLIS Trading</div>
        <div style={{ fontSize: 26, fontWeight: 900, color: "#0f172a", letterSpacing: "-0.03em" }}>
          🧪 What-If Analyzer
        </div>
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
          จำลองผลลัพธ์จากประวัติ trade จริง ถ้าใช้ parameters ต่างออกไป
        </div>
      </div>

      {/* Controls */}
      <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)",
        borderRadius: 16, padding: "20px 24px", marginBottom: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24, marginBottom: 20 }}>

          {/* Confidence */}
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, color: "#475569",
              textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>
              Min Confidence: <span style={{ color: "#6366f1" }}>{minConf}%</span>
            </div>
            <input type="range" min={40} max={95} step={5} value={minConf}
              onChange={e => setMinConf(+e.target.value)}
              style={{ width: "100%", accentColor: "#6366f1" }} />
            <div style={{ display: "flex", justifyContent: "space-between",
              fontSize: 8, color: "#94a3b8", marginTop: 4 }}>
              <span>40% (กว้าง)</span><span>95% (เข้มงวด)</span>
            </div>
          </div>

          {/* Reward Ratio */}
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, color: "#475569",
              textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>
              Reward Ratio: <span style={{ color: "#10b981" }}>{ratio.toFixed(1)}×</span>
            </div>
            <input type="range" min={1.0} max={5.0} step={0.5} value={ratio}
              onChange={e => setRatio(+e.target.value)}
              style={{ width: "100%", accentColor: "#10b981" }} />
            <div style={{ display: "flex", justifyContent: "space-between",
              fontSize: 8, color: "#94a3b8", marginTop: 4 }}>
              <span>1× (TP=SL)</span><span>5× (TP ไกล)</span>
            </div>
          </div>

          {/* Exclude symbols */}
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, color: "#475569",
              textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>
              ยกเว้น Symbol
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {ALL_SYMBOLS.map(sym => (
                <Chip key={sym} label={sym} active={excluded.has(sym)}
                  color="#ef4444" onClick={() => toggleSym(sym)} />
              ))}
            </div>
          </div>
        </div>

        <button type="button" onClick={run} disabled={loading} style={{
          padding: "10px 28px", borderRadius: 10, fontSize: 13, fontWeight: 800,
          cursor: loading ? "not-allowed" : "pointer",
          background: loading ? "#e2e8f0"
            : "linear-gradient(135deg,#6366f1,#818cf8)",
          color: loading ? "#94a3b8" : "#fff", border: "none",
          boxShadow: loading ? "none" : "0 4px 14px rgba(99,102,241,0.35)",
        }}>
          {loading ? "กำลังคำนวณ…" : "🧪 Run Simulation"}
        </button>
      </div>

      {/* Results */}
      {result && s && (
        <>
          {/* KPI row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 12, marginBottom: 20 }}>
            {[
              { label: "Trades",    value: String(s.total),       color: "#64748b" },
              { label: "Win Rate",  value: `${s.win_rate}%`,      color: s.win_rate >= 50 ? "#10b981" : "#ef4444" },
              { label: "Sim P&L",  value: `${s.sim_pnl >= 0 ? "+" : ""}$${s.sim_pnl.toFixed(0)}`,
                color: s.sim_pnl >= 0 ? "#10b981" : "#ef4444" },
              { label: "vs. Real", value: `${s.pnl_delta >= 0 ? "+" : ""}$${s.pnl_delta.toFixed(0)}`,
                color: s.pnl_delta >= 0 ? "#10b981" : "#ef4444" },
              { label: "Avg Win",  value: `+$${s.avg_win.toFixed(0)}`,  color: "#10b981" },
              { label: "R:R",      value: rr,                    color: "#818cf8" },
            ].map(k => (
              <div key={k.label} style={{ background: `linear-gradient(135deg,${k.color}08,#fff)`,
                border: `1px solid ${k.color}22`, borderRadius: 12, padding: "14px 16px" }}>
                <div style={{ fontSize: 8, color: "#64748b", textTransform: "uppercase",
                  letterSpacing: "0.1em", fontWeight: 700, marginBottom: 4 }}>{k.label}</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: k.color,
                  fontFamily: "var(--font-mono,monospace)", lineHeight: 1 }}>{k.value}</div>
              </div>
            ))}
          </div>

          {/* Real vs Sim comparison banner */}
          <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)",
            borderRadius: 14, padding: "16px 20px", marginBottom: 20,
            display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
            <div style={{ fontSize: 10, color: "#64748b" }}>เปรียบเทียบกับ real history:</div>
            <div style={{ display: "flex", gap: 16 }}>
              <div>
                <span style={{ fontSize: 9, color: "#94a3b8", marginRight: 6 }}>Real P&L</span>
                <span style={{ fontWeight: 800, fontFamily: "var(--font-mono,monospace)",
                  color: s.orig_pnl >= 0 ? "#10b981" : "#ef4444", fontSize: 14 }}>
                  {s.orig_pnl >= 0 ? "+" : ""}${s.orig_pnl.toFixed(0)}
                </span>
              </div>
              <div style={{ color: "#94a3b8" }}>→</div>
              <div>
                <span style={{ fontSize: 9, color: "#94a3b8", marginRight: 6 }}>Sim P&L</span>
                <span style={{ fontWeight: 800, fontFamily: "var(--font-mono,monospace)",
                  color: s.sim_pnl >= 0 ? "#10b981" : "#ef4444", fontSize: 14 }}>
                  {s.sim_pnl >= 0 ? "+" : ""}${s.sim_pnl.toFixed(0)}
                </span>
              </div>
              <div style={{ padding: "3px 10px", borderRadius: 8, fontWeight: 700,
                fontSize: 12, fontFamily: "var(--font-mono,monospace)",
                background: s.pnl_delta >= 0 ? "rgba(16,185,129,0.1)" : "rgba(239,68,68,0.1)",
                color: s.pnl_delta >= 0 ? "#10b981" : "#ef4444" }}>
                {s.pnl_delta >= 0 ? "+" : ""}${s.pnl_delta.toFixed(0)} difference
              </div>
            </div>
          </div>

          {/* By-symbol */}
          <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)",
            borderRadius: 14, padding: "20px 24px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#475569",
              textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>
              By Symbol (Simulated)
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[...result.by_symbol].sort((a, b) => b.sim_pnl - a.sim_pnl).map(sym => {
                const c   = sym.sim_pnl >= 0 ? "#10b981" : "#ef4444";
                const pct = Math.round(Math.abs(sym.sim_pnl) / maxAbsPnl * 100);
                return (
                  <div key={sym.symbol}>
                    <div style={{ display: "flex", justifyContent: "space-between",
                      alignItems: "center", marginBottom: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 12, fontWeight: 800, color: "#0f172a",
                          fontFamily: "var(--font-mono,monospace)", width: 70 }}>{sym.symbol}</span>
                        <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 6,
                          background: `${c}15`, color: c, fontWeight: 700 }}>WR {sym.win_rate}%</span>
                        <span style={{ fontSize: 9, color: "#94a3b8" }}>{sym.trades} trades</span>
                      </div>
                      <span style={{ fontSize: 14, fontWeight: 900, color: c,
                        fontFamily: "var(--font-mono,monospace)" }}>
                        {sym.sim_pnl >= 0 ? "+" : ""}${sym.sim_pnl.toFixed(0)}
                      </span>
                    </div>
                    <div style={{ height: 6, borderRadius: 3, background: "#f1f5f9", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`,
                        borderRadius: 3, background: c }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
