"use client";
import { useEffect, useState, useCallback } from "react";

const GW = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";

type Trade = {
  id: number; symbol: string; direction: string; price: number;
  exit_price: number; pnl_usd: number; trade_result: string;
  lots: number; exit_at: string;
};
type EquityPoint = { ts: string; cum_pnl: number; pnl: number; trade_result: string };

function _fp(v: number) {
  if (v < 10)   return `$${v.toFixed(5)}`;
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(0)}`;
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div style={{ background: `linear-gradient(135deg,${color}08,#fff)`, border: `1px solid ${color}22`,
      borderRadius: 14, padding: "18px 20px" }}>
      <div style={{ fontSize: 9, color: "#64748b", textTransform: "uppercase" as const,
        letterSpacing: "0.1em", fontWeight: 700, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 900, color, fontFamily: "var(--font-mono,monospace)",
        lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function getSession(dateStr: string): "Asian" | "London" | "NY" {
  const h = new Date(dateStr).getUTCHours();
  if (h >= 8 && h < 16) return "London";
  if (h >= 16)          return "NY";
  return "Asian";
}

function DrawdownChart({ points }: { points: EquityPoint[] }) {
  if (points.length < 2) return (
    <div style={{ height: 80, display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8", fontSize: 11 }}>ยังไม่มีข้อมูล</div>
  );
  let peak = 0;
  const dds = points.map(p => {
    if (p.cum_pnl > peak) peak = p.cum_pnl;
    return peak > 0 ? ((peak - p.cum_pnl) / peak) * 100 : 0;
  });
  const maxDD  = Math.max(...dds);
  const W = 500; const H = 80; const PAD = 6;
  const svgPts = dds.map((d, i) => {
    const x = PAD + (i / (dds.length - 1)) * (W - PAD * 2);
    const y = PAD + (d / (maxDD || 1)) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const first = svgPts.split(" ")[0];
  const last  = svgPts.split(" ").at(-1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 80 }}>
      <polygon points={`${PAD},${PAD} ${svgPts} ${last?.split(",")[0]},${PAD}`}
        fill="rgba(239,68,68,0.12)" />
      <polyline points={svgPts} fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <line x1={PAD} y1={PAD} x2={W - PAD} y2={PAD} stroke="rgba(239,68,68,0.2)" strokeWidth="1" strokeDasharray="4,3"/>
    </svg>
  );
}

function MiniChart({ points }: { points: EquityPoint[] }) {
  if (points.length < 2) return (
    <div style={{ height: 120, display: "flex", alignItems: "center",
      justifyContent: "center", color: "#94a3b8", fontSize: 11 }}>ยังไม่มีข้อมูล</div>
  );
  const vals  = points.map(p => p.cum_pnl);
  const min   = Math.min(...vals);
  const max   = Math.max(...vals);
  const range = max - min || 1;
  const W = 500; const H = 120; const PAD = 8;
  const pts = points.map((p, i) => {
    const x = PAD + (i / (points.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((p.cum_pnl - min) / range) * (H - PAD * 2);
    return `${x},${y}`;
  }).join(" ");
  const last = points[points.length - 1].cum_pnl;
  const color = last >= 0 ? "#10b981" : "#ef4444";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 120 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points={`${PAD},${H - PAD} ${pts} ${W - PAD},${H - PAD}`}
        fill={`${color}18`} stroke="none" />
    </svg>
  );
}

export default function PerformancePage() {
  const [trades, setTrades]   = useState<Trade[]>([]);
  const [equity, setEquity]   = useState<EquityPoint[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [t, e] = await Promise.all([
      fetch(`${GW}/trades?limit=200&status=closed`).then(r => r.json()).catch(() => []),
      fetch(`${GW}/equity`).then(r => r.json()).catch(() => []),
    ]);
    setTrades(Array.isArray(t) ? t : []);
    setEquity(Array.isArray(e) ? e : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const closed = trades.filter(t => t.trade_result);
  const wins   = closed.filter(t => t.trade_result === "WIN");
  const losses = closed.filter(t => t.trade_result === "LOSS");
  const totalPnl  = closed.reduce((s, t) => s + t.pnl_usd, 0);
  const winRate   = closed.length > 0 ? Math.round(wins.length / closed.length * 100) : 0;
  const avgWin    = wins.length   > 0 ? wins.reduce((s, t) => s + t.pnl_usd, 0) / wins.length : 0;
  const avgLoss   = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl_usd, 0) / losses.length) : 0;
  const best      = closed.length > 0 ? Math.max(...closed.map(t => t.pnl_usd)) : 0;
  const worst     = closed.length > 0 ? Math.min(...closed.map(t => t.pnl_usd)) : 0;

  // Drawdown
  let ddPeak = 0, maxDD = 0, currentDD = 0;
  equity.forEach(p => {
    if (p.cum_pnl > ddPeak) ddPeak = p.cum_pnl;
    const dd = ddPeak > 0 ? ((ddPeak - p.cum_pnl) / ddPeak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
    currentDD = dd;
  });
  const ddFromPeak = ddPeak > 0 ? ddPeak - (equity[equity.length - 1]?.cum_pnl ?? 0) : 0;

  // Session P&L
  const SESSION_COLS = { Asian: "#f472b6", London: "#818cf8", NY: "#22d3ee" };
  const sessMap: Record<string, { pnl: number; count: number; wins: number }> = {
    Asian: { pnl: 0, count: 0, wins: 0 },
    London: { pnl: 0, count: 0, wins: 0 },
    NY: { pnl: 0, count: 0, wins: 0 },
  };
  closed.forEach(t => {
    const s = getSession(t.exit_at);
    sessMap[s].pnl   += t.pnl_usd;
    sessMap[s].count += 1;
    if (t.trade_result === "WIN") sessMap[s].wins += 1;
  });
  const sessRows = Object.entries(sessMap) as [string, { pnl: number; count: number; wins: number }][];
  const maxSessPnl = Math.max(...sessRows.map(([, s]) => Math.abs(s.pnl)), 1);

  // Per-symbol breakdown
  const symMap: Record<string, { pnl: number; count: number; wins: number }> = {};
  closed.forEach(t => {
    if (!symMap[t.symbol]) symMap[t.symbol] = { pnl: 0, count: 0, wins: 0 };
    symMap[t.symbol].pnl   += t.pnl_usd;
    symMap[t.symbol].count += 1;
    if (t.trade_result === "WIN") symMap[t.symbol].wins += 1;
  });
  const symRows = Object.entries(symMap).sort(([,a],[,b]) => b.pnl - a.pnl);
  const maxAbsPnl = Math.max(...symRows.map(([,s]) => Math.abs(s.pnl)), 1);

  // Weekly breakdown
  const weekMap: Record<string, { pnl: number; count: number; wins: number }> = {};
  closed.forEach(t => {
    const d   = new Date(t.exit_at);
    const mon = new Date(d); mon.setDate(d.getDate() - d.getDay() + 1);
    const key = mon.toISOString().slice(0, 10);
    if (!weekMap[key]) weekMap[key] = { pnl: 0, count: 0, wins: 0 };
    weekMap[key].pnl   += t.pnl_usd;
    weekMap[key].count += 1;
    if (t.trade_result === "WIN") weekMap[key].wins += 1;
  });
  const weeks = Object.entries(weekMap).sort(([a], [b]) => a.localeCompare(b)).slice(-8);

  if (loading) return (
    <div style={{ padding: 40, color: "#94a3b8", fontSize: 13 }}>กำลังโหลด…</div>
  );

  return (
    <div style={{ padding: "28px 32px 60px", background: "#f8fafc", minHeight: "100vh" }}>
      <div style={{ marginBottom: 28, display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.15em",
            textTransform: "uppercase", marginBottom: 6 }}>POLIS Trading</div>
          <div style={{ fontSize: 26, fontWeight: 900, color: "#0f172a", letterSpacing: "-0.03em" }}>
            📈 Performance Report
          </div>
        </div>
        <a href={`${GW}/trades/export.csv`} download style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "9px 18px", borderRadius: 10, fontSize: 12, fontWeight: 700,
          background: "linear-gradient(135deg,#10b981,#059669)",
          color: "#fff", textDecoration: "none",
          boxShadow: "0 2px 8px rgba(16,185,129,0.25)",
        }}>
          ⬇️ Export CSV
        </a>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 12, marginBottom: 24 }}>
        <StatCard label="Total P&L"    value={`${totalPnl >= 0 ? "+" : ""}$${Math.abs(totalPnl).toFixed(0)}`}
          color={totalPnl >= 0 ? "#10b981" : "#ef4444"} sub={`${closed.length} trades`} />
        <StatCard label="Win Rate"     value={`${winRate}%`}
          color={winRate >= 50 ? "#10b981" : "#ef4444"} sub={`${wins.length}W / ${losses.length}L`} />
        <StatCard label="Avg Win"      value={`+$${avgWin.toFixed(0)}`}   color="#10b981" />
        <StatCard label="Avg Loss"     value={`-$${avgLoss.toFixed(0)}`}  color="#ef4444" />
        <StatCard label="Best Trade"   value={`+$${best.toFixed(0)}`}     color="#818cf8" />
        <StatCard label="Worst Trade"  value={`-$${Math.abs(worst).toFixed(0)}`} color="#f59e0b" />
      </div>

      {/* Equity Curve */}
      <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)",
        borderRadius: 16, padding: "20px 24px", marginBottom: 20 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#475569",
          textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Equity Curve</div>
        <MiniChart points={equity} />
      </div>

      {/* Drawdown */}
      <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 16, padding: "20px 24px", marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase" as const, letterSpacing: "0.1em" }}>
            Drawdown
          </div>
          <div style={{ display: "flex", gap: 20 }}>
            <div style={{ textAlign: "right" as const }}>
              <div style={{ fontSize: 8, color: "#94a3b8", marginBottom: 2 }}>Max DD</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#ef4444", fontFamily: "var(--font-mono,monospace)" }}>
                {maxDD.toFixed(1)}%
              </div>
            </div>
            <div style={{ textAlign: "right" as const }}>
              <div style={{ fontSize: 8, color: "#94a3b8", marginBottom: 2 }}>Current DD</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: currentDD > 5 ? "#ef4444" : currentDD > 0 ? "#f59e0b" : "#10b981", fontFamily: "var(--font-mono,monospace)" }}>
                {currentDD.toFixed(1)}%
              </div>
            </div>
            <div style={{ textAlign: "right" as const }}>
              <div style={{ fontSize: 8, color: "#94a3b8", marginBottom: 2 }}>Underwater</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: ddFromPeak > 0 ? "#ef4444" : "#10b981", fontFamily: "var(--font-mono,monospace)" }}>
                {ddFromPeak > 0 ? "-" : ""}${Math.abs(ddFromPeak).toFixed(0)}
              </div>
            </div>
          </div>
        </div>
        <DrawdownChart points={equity} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#94a3b8", marginTop: 4 }}>
          <span>กราฟแสดง % drawdown จาก equity peak ณ แต่ละจุด</span>
          <span>peak ${ddPeak.toFixed(0)}</span>
        </div>
      </div>

      {/* By-Symbol Breakdown */}
      {symRows.length > 0 && (
        <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)",
          borderRadius: 16, padding: "20px 24px", marginBottom: 20 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#475569",
            textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>
            By Symbol
          </div>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 10 }}>
            {symRows.map(([sym, s]) => {
              const c  = s.pnl >= 0 ? "#10b981" : "#ef4444";
              const wr = s.count > 0 ? Math.round(s.wins / s.count * 100) : 0;
              const barPct = Math.round(Math.abs(s.pnl) / maxAbsPnl * 100);
              return (
                <div key={sym}>
                  <div style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "center", marginBottom: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: "#0f172a",
                        fontFamily: "var(--font-mono,monospace)", width: 64 }}>{sym}</span>
                      <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 6,
                        background: `${c}15`, color: c, fontWeight: 700 }}>
                        WR {wr}%
                      </span>
                      <span style={{ fontSize: 9, color: "#94a3b8" }}>{s.count} trades</span>
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 900, color: c,
                      fontFamily: "var(--font-mono,monospace)" }}>
                      {s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(0)}
                    </span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: "#f1f5f9", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${barPct}%`,
                      borderRadius: 3, background: c, transition: "width 0.4s" }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Session P&L */}
      <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 16, padding: "20px 24px", marginBottom: 20 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: 16 }}>
          Session P&L
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 16 }}>
          {sessRows.map(([sess, s]) => {
            const c  = s.pnl >= 0 ? "#10b981" : "#ef4444";
            const sc = (SESSION_COLS as Record<string,string>)[sess] ?? "#6366f1";
            const wr = s.count > 0 ? Math.round(s.wins / s.count * 100) : 0;
            return (
              <div key={sess} style={{ padding: "14px 16px", borderRadius: 12, background: `${sc}08`, border: `1px solid ${sc}22` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: sc }} />
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#1e293b" }}>{sess}</span>
                  <span style={{ fontSize: 9, color: "#94a3b8" }}>
                    {sess === "Asian" ? "00–08 UTC" : sess === "London" ? "08–16 UTC" : "16–24 UTC"}
                  </span>
                </div>
                <div style={{ fontSize: 22, fontWeight: 900, color: c, fontFamily: "var(--font-mono,monospace)", lineHeight: 1, marginBottom: 6 }}>
                  {s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(0)}
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 6, background: `${c}15`, color: c, fontWeight: 700 }}>
                    WR {wr}%
                  </span>
                  <span style={{ fontSize: 9, color: "#94a3b8" }}>{s.count} trades</span>
                </div>
                <div style={{ marginTop: 8, height: 5, borderRadius: 3, background: "#f1f5f9", overflow: "hidden" }}>
                  <div style={{ height: "100%", borderRadius: 3, background: c, width: `${Math.round(Math.abs(s.pnl) / maxSessPnl * 100)}%`, transition: "width 0.4s" }} />
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 9, color: "#94a3b8" }}>
          แบ่งตาม UTC เวลาปิด trade · Asian = Tokyo · London = European · NY = American
        </div>
      </div>

      {/* Weekly Breakdown */}
      {weeks.length > 0 && (
        <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)",
          borderRadius: 16, padding: "20px 24px", marginBottom: 20 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#475569",
            textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>รายสัปดาห์</div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${weeks.length},1fr)`, gap: 8 }}>
            {weeks.map(([week, w]) => {
              const c = w.pnl >= 0 ? "#10b981" : "#ef4444";
              const wr = w.count > 0 ? Math.round(w.wins / w.count * 100) : 0;
              return (
                <div key={week} style={{ textAlign: "center", padding: "12px 8px",
                  borderRadius: 10, background: `${c}0d`, border: `1px solid ${c}22` }}>
                  <div style={{ fontSize: 8, color: "#64748b", marginBottom: 4 }}>
                    {week.slice(5)}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: c,
                    fontFamily: "var(--font-mono,monospace)" }}>
                    {w.pnl >= 0 ? "+" : ""}${w.pnl.toFixed(0)}
                  </div>
                  <div style={{ fontSize: 8, color: "#94a3b8", marginTop: 2 }}>
                    {w.count} trades · {wr}%
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Trade History */}
      <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 16, padding: "20px 24px" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#475569",
          textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>
          Trade History ({closed.length})
        </div>
        {closed.length === 0 ? (
          <div style={{ color: "#94a3b8", fontSize: 12, padding: "20px 0" }}>ยังไม่มี trade ที่ปิดแล้ว</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
                  {["#", "Symbol", "Direction", "Entry", "Exit", "Lots", "P&L", "Result", "Closed"].map(h => (
                    <th key={h} style={{ padding: "6px 10px", textAlign: "left" as const,
                      color: "#64748b", fontWeight: 700, fontSize: 9,
                      textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...closed].reverse().slice(0, 50).map(t => {
                  const win = t.trade_result === "WIN";
                  const col = win ? "#10b981" : "#ef4444";
                  return (
                    <tr key={t.id} style={{ borderBottom: "1px solid rgba(0,0,0,0.04)" }}>
                      <td style={{ padding: "7px 10px", color: "#94a3b8" }}>#{t.id}</td>
                      <td style={{ padding: "7px 10px", fontWeight: 700 }}>{t.symbol}</td>
                      <td style={{ padding: "7px 10px" }}>
                        <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 6, fontWeight: 700,
                          background: t.direction === "long" ? "#10b98118" : "#ef444418",
                          color: t.direction === "long" ? "#10b981" : "#ef4444" }}>
                          {t.direction.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: "7px 10px", fontFamily: "var(--font-mono,monospace)" }}>{_fp(t.price)}</td>
                      <td style={{ padding: "7px 10px", fontFamily: "var(--font-mono,monospace)" }}>{_fp(t.exit_price)}</td>
                      <td style={{ padding: "7px 10px", color: "#64748b" }}>{t.lots?.toFixed(2)}</td>
                      <td style={{ padding: "7px 10px", fontWeight: 700, color: col,
                        fontFamily: "var(--font-mono,monospace)" }}>
                        {t.pnl_usd >= 0 ? "+" : ""}${t.pnl_usd?.toFixed(2)}
                      </td>
                      <td style={{ padding: "7px 10px" }}>
                        <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 6, fontWeight: 700,
                          background: `${col}18`, color: col }}>
                          {win ? "WIN" : "LOSS"}
                        </span>
                      </td>
                      <td style={{ padding: "7px 10px", color: "#94a3b8", fontSize: 9 }}>
                        {t.exit_at ? new Date(t.exit_at).toLocaleString("th-TH", {
                          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
                        }) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
