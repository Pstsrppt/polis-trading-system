"use client";
import { useEffect, useState, useCallback } from "react";

const GW = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EquityPoint {
  ts: string | null;
  cum_pnl: number;
  pnl: number;
  trade_result: string;
}

interface DayData {
  day: string;
  pnl: number;
  trades: number;
  wins: number;
}

interface SymbolStat {
  symbol: string;
  total: number;
  wins: number;
  pnl: number;
  win_rate: number;
  total_risk_usd: number;
  avg_risk_usd: number;
}

interface MonthStat {
  month: string;
  total: number;
  wins: number;
  pnl: number;
  win_rate: number;
}

interface Analytics {
  overall: {
    total_closed: number;
    wins: number;
    losses: number;
    total_pnl: number;
    win_rate: number;
    best_trade: number;
    worst_trade: number;
  };
  best_day: number;
  worst_day: number;
  daily: DayData[];
  symbols: SymbolStat[];
  monthly: MonthStat[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtUsd(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function monthLabel(iso: string): string {
  const [year, month] = iso.split("-");
  return `${MONTH_NAMES[parseInt(month) - 1]} ${year}`;
}

// ── Equity Curve SVG ──────────────────────────────────────────────────────────

function EquityCurve({ points }: { points: EquityPoint[] }) {
  if (points.length < 2) {
    return (
      <div style={{ display:"flex", alignItems:"center", justifyContent:"center",
        height:160, color:"#64748b", fontSize:13 }}>
        ยังไม่มีเทรดที่ปิดแล้ว — run <code style={{ marginLeft:6 }}>python tools/seed_demo_data.py</code>
      </div>
    );
  }

  const W = 800, H = 160, PX = 24, PY = 20;
  const vals = points.map(p => p.cum_pnl);
  const minV = Math.min(0, ...vals);
  const maxV = Math.max(0, ...vals);
  const range = maxV - minV || 1;

  const toX = (i: number) => PX + (i / (points.length - 1)) * (W - 2 * PX);
  const toY = (v: number) => H - PY - ((v - minV) / range) * (H - 2 * PY);
  const zeroY = toY(0);

  const pts     = points.map((p, i) => `${toX(i).toFixed(1)},${toY(p.cum_pnl).toFixed(1)}`).join(" ");
  const fillPts = `${toX(0).toFixed(1)},${zeroY.toFixed(1)} ${pts} ${toX(points.length-1).toFixed(1)},${zeroY.toFixed(1)}`;

  const lastVal = vals[vals.length - 1];
  const color   = lastVal >= 0 ? "#10b981" : "#ef4444";

  // Y-axis tick labels
  const yTicks = [
    { v: maxV, y: toY(maxV) },
    { v: (maxV + minV) / 2, y: toY((maxV + minV) / 2) },
    { v: minV, y: toY(minV) },
  ];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
      style={{ width:"100%", height:160, display:"block" }}>
      <defs>
        <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {/* Y-axis labels */}
      {yTicks.map(({ v, y }) => (
        <text key={v} x={PX - 4} y={y + 4} textAnchor="end"
          fontSize="9" fill="rgba(100,116,139,0.8)">
          {v >= 0 ? "+" : ""}{Math.round(v)}
        </text>
      ))}

      {/* Zero baseline */}
      <line x1={PX} y1={zeroY} x2={W - PX} y2={zeroY}
        stroke="rgba(0,0,0,0.07)" strokeWidth="1" strokeDasharray="4,4" />

      {/* Fill */}
      <polygon points={fillPts} fill="url(#eqGrad)" />

      {/* Line */}
      <polyline points={pts} fill="none"
        stroke={color} strokeWidth="2" strokeLinejoin="round" />

      {/* Terminal dot */}
      <circle cx={toX(points.length - 1)} cy={toY(lastVal)} r="4" fill={color} />

      {/* Terminal label */}
      <text x={toX(points.length - 1) + 7} y={toY(lastVal) + 4}
        fontSize="10" fontWeight="700" fill={color}>
        {fmtUsd(lastVal)}
      </text>
    </svg>
  );
}

// ── P&L Calendar Heatmap ──────────────────────────────────────────────────────

function PnLCalendar({ daily }: { daily: DayData[] }) {
  const dayMap = new Map(daily.map(d => [d.day, d]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Start from Sunday ~52 weeks ago
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  start.setDate(start.getDate() - start.getDay());   // align to Sunday

  type Cell = { date: string; pnl?: number; trades?: number; isFuture: boolean };
  const weeks: Cell[][] = [];
  const cur = new Date(start);

  while (weeks.length < 53) {
    const week: Cell[] = [];
    for (let d = 0; d < 7; d++) {
      const iso      = cur.toISOString().split("T")[0];
      const isFuture = cur > today;
      const data     = dayMap.get(iso);
      week.push({ date: iso, pnl: data?.pnl, trades: data?.trades, isFuture });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }

  const allAbs  = daily.map(d => Math.abs(d.pnl));
  const maxAbs  = Math.max(...allAbs, 1);

  function cellBg(pnl?: number, isFuture?: boolean): string {
    if (isFuture)         return "transparent";
    if (pnl === undefined) return "rgba(0,0,0,0.03)";
    if (pnl === 0)         return "rgba(0,0,0,0.05)";
    const intensity = Math.min(Math.abs(pnl) / maxAbs, 1);
    const alpha     = (0.30 + intensity * 0.70).toFixed(2);
    return pnl > 0
      ? `rgba(16,185,129,${alpha})`
      : `rgba(239,68,68,${alpha})`;
  }

  const DAY_LABELS = ["S","M","T","W","T","F","S"];

  return (
    <div style={{ overflowX:"auto" }}>
      <div style={{ display:"flex", gap:3, minWidth:"fit-content" }}>

        {/* Day labels column */}
        <div style={{ display:"flex", flexDirection:"column", gap:3, marginTop:20 }}>
          {DAY_LABELS.map((label, i) => (
            <div key={i} style={{ height:11, width:10, fontSize:8, color:"#64748b",
              lineHeight:"11px", textAlign:"center" }}>
              {i % 2 === 1 ? label : ""}
            </div>
          ))}
        </div>

        {/* Grid */}
        <div style={{ display:"flex", flexDirection:"column", gap:2 }}>

          {/* Month headers */}
          <div style={{ display:"flex", gap:3 }}>
            {weeks.map((week, wi) => {
              const d    = new Date(week[0].date);
              const show = d.getDate() <= 7 ? MONTH_NAMES[d.getMonth()] : "";
              return (
                <div key={wi} style={{ width:11, fontSize:8, color:"#64748b",
                  whiteSpace:"nowrap", textAlign:"left" }}>
                  {show}
                </div>
              );
            })}
          </div>

          {/* Day rows 0-6 */}
          {[0,1,2,3,4,5,6].map(dow => (
            <div key={dow} style={{ display:"flex", gap:3 }}>
              {weeks.map((week, wi) => {
                const cell = week[dow];
                const tip  = cell.pnl !== undefined
                  ? `${cell.date}: ${cell.pnl >= 0 ? "+" : ""}$${cell.pnl.toFixed(0)} · ${cell.trades} trade${cell.trades !== 1 ? "s" : ""}`
                  : cell.date;
                return (
                  <div key={wi} title={tip} style={{
                    width:11, height:11, borderRadius:2,
                    background: cellBg(cell.pnl, cell.isFuture),
                    cursor: cell.pnl !== undefined ? "pointer" : "default",
                  }} />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div style={{ display:"flex", gap:6, marginTop:12, alignItems:"center" }}>
        <span style={{ fontSize:10, color:"#64748b" }}>Loss</span>
        {[0.3, 0.55, 0.75, 1.0].map(op => (
          <div key={op} style={{ width:11, height:11, borderRadius:2,
            background:`rgba(239,68,68,${op})` }} />
        ))}
        <div style={{ width:11, height:11, borderRadius:2,
          background:"rgba(0,0,0,0.04)" }} />
        {[0.3, 0.55, 0.75, 1.0].map(op => (
          <div key={op} style={{ width:11, height:11, borderRadius:2,
            background:`rgba(16,185,129,${op})` }} />
        ))}
        <span style={{ fontSize:10, color:"#64748b" }}>Profit</span>
      </div>
    </div>
  );
}

// ── KPI Card ──────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color: string;
}) {
  return (
    <div style={{
      flex:1, minWidth:0,
      background:"#ffffff",
      border:"1px solid rgba(0,0,0,0.07)",
      borderRadius:12, padding:"16px 20px",
    }}>
      <div style={{ fontSize:11, color:"#64748b", letterSpacing:"0.08em",
        textTransform:"uppercase" as const }}>
        {label}
      </div>
      <div style={{ fontSize:26, fontWeight:800, color, marginTop:6,
        letterSpacing:"-0.02em", fontVariantNumeric:"tabular-nums" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize:11, color:"#64748b", marginTop:4 }}>{sub}</div>}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FinancePage() {
  const [equity,    setEquity]    = useState<EquityPoint[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [refreshed, setรีเฟรชed] = useState<Date | null>(null);
  const [loading,   setLoading]   = useState(true);

  const load = useCallback(async () => {
    try {
      const [eqRes, anRes] = await Promise.all([
        fetch(`${GW}/equity`),
        fetch(`${GW}/analytics`),
      ]);
      if (eqRes.ok) setEquity(await eqRes.json());
      if (anRes.ok) setAnalytics(await anRes.json());
      setรีเฟรชed(new Date());
    } catch { /* gateway offline */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const ov       = analytics?.overall;
  const totalPnl = ov?.total_pnl  ?? 0;
  const winRate  = ov?.win_rate   ?? 0;
  const bestDay  = analytics?.best_day  ?? 0;
  const worstDay = analytics?.worst_day ?? 0;

  return (
    <div className="page dot-bg">

      {/* ── Header ── */}
      <div style={{ display:"flex", alignItems:"center",
        justifyContent:"space-between", marginBottom:24 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:800, margin:0 }}>การเงิน & การวิเคราะห์</h1>
          <div style={{ fontSize:12, color:"#64748b", marginTop:4 }}>
            {refreshed
              ? `Updated ${refreshed.toLocaleTimeString("th-TH")}`
              : "Loading…"}
          </div>
        </div>
        <button onClick={load} style={{
          padding:"8px 16px", borderRadius:8, fontSize:12, fontWeight:600,
          background:"rgba(99,102,241,0.15)", border:"1px solid rgba(99,102,241,0.3)",
          color:"#818cf8", cursor:"pointer",
        }}>
          รีเฟรช
        </button>
      </div>

      {/* ── KPI Strip ── */}
      <div style={{ display:"flex", gap:12, marginBottom:20, flexWrap:"wrap" }}>
        <KpiCard
          label="P&L รวม"
          value={loading ? "—" : fmtUsd(totalPnl)}
          sub={`${ov?.total_closed ?? 0} เทรดที่ปิดแล้ว`}
          color={totalPnl >= 0 ? "#10b981" : "#ef4444"}
        />
        <KpiCard
          label="อัตราชนะ"
          value={loading ? "—" : fmtPct(winRate)}
          sub={`${ov?.wins ?? 0}W · ${ov?.losses ?? 0}L`}
          color={winRate >= 60 ? "#10b981" : winRate >= 50 ? "#f59e0b" : "#ef4444"}
        />
        <KpiCard
          label="วันที่ดีที่สุด"
          value={loading ? "—" : fmtUsd(bestDay)}
          sub="P&L ต่อเซสชัน"
          color="#10b981"
        />
        <KpiCard
          label="วันที่แย่ที่สุด"
          value={loading ? "—" : fmtUsd(worstDay)}
          sub="P&L ต่อเซสชัน"
          color="#ef4444"
        />
      </div>

      {/* ── Equity Curve ── */}
      <div className="glass" style={{ borderRadius:16, padding:20, marginBottom:20 }}>
        <div style={{ fontSize:12, fontWeight:700, color:"#64748b",
          letterSpacing:"0.06em", marginBottom:12 }}>
          เส้นโค้งทุน
          <span style={{ marginLeft:12, fontWeight:400, color:"#64748b" }}>
            P&L สะสม ·{equity.length} data points
          </span>
        </div>
        <EquityCurve points={equity} />
      </div>

      {/* ── Calendar + Symbols ── */}
      <div style={{ display:"grid", gridTemplateColumns:"minmax(0,1fr) 280px",
        gap:20, marginBottom:20 }}>

        {/* Calendar */}
        <div className="glass" style={{ borderRadius:16, padding:20 }}>
          <div style={{ fontSize:12, fontWeight:700, color:"#64748b",
            letterSpacing:"0.06em", marginBottom:16 }}>
            ปฏิทิน P&L
            <span style={{ marginLeft:12, fontWeight:400, color:"#64748b" }}>
              12 เดือนล่าสุด · รายวัน
            </span>
          </div>
          <PnLCalendar daily={analytics?.daily ?? []} />
        </div>

        {/* Symbol Breakdown */}
        <div className="glass" style={{ borderRadius:16, padding:20 }}>
          <div style={{ fontSize:12, fontWeight:700, color:"#64748b",
            letterSpacing:"0.06em", marginBottom:16 }}>
            BY SYMBOL
          </div>

          {analytics?.symbols.length ? analytics.symbols.map(sym => (
            <div key={sym.symbol} style={{ marginBottom:18 }}>
              <div style={{ display:"flex", justifyContent:"space-between",
                fontSize:12, marginBottom:6 }}>
                <span style={{ fontWeight:700, color:"#1e293b",
                  fontFamily:"var(--font-mono, monospace)" }}>
                  {sym.symbol}
                </span>
                <span style={{
                  color: sym.win_rate >= 60 ? "#10b981" : sym.win_rate >= 50 ? "#f59e0b" : "#ef4444",
                  fontWeight:700,
                }}>
                  {fmtPct(sym.win_rate)}
                </span>
              </div>
              <div style={{ height:6, borderRadius:3,
                background:"rgba(0,0,0,0.05)", overflow:"hidden" }}>
                <div style={{
                  height:"100%", borderRadius:3,
                  width:`${Math.min(sym.win_rate, 100)}%`,
                  background: sym.win_rate >= 60 ? "#10b981"
                    : sym.win_rate >= 50 ? "#f59e0b" : "#ef4444",
                  transition:"width 0.6s ease",
                }} />
              </div>
              <div style={{ display:"flex", gap:12, fontSize:10, marginTop:5 }}>
                <span style={{ color:"#64748b" }}>{sym.total} trades</span>
                <span style={{ color: sym.pnl >= 0 ? "#10b981" : "#ef4444" }}>
                  {fmtUsd(sym.pnl)}
                </span>
                {sym.avg_risk_usd > 0 && (
                  <span style={{ color:"#f59e0b", marginLeft:"auto" }}
                    title="avg risk per approved trade">
                    ~${sym.avg_risk_usd.toFixed(0)}/trade
                  </span>
                )}
              </div>
            </div>
          )) : (
            <div style={{ color:"#64748b", fontSize:12 }}>ยังไม่มีเทรดที่ปิดแล้ว.</div>
          )}
        </div>
      </div>

      {/* ── Monthly Table ── */}
      <div className="glass" style={{ borderRadius:16, padding:20 }}>
        <div style={{ fontSize:12, fontWeight:700, color:"#64748b",
          letterSpacing:"0.06em", marginBottom:16 }}>
          ผลการดำเนินงานรายเดือน
        </div>

        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
          <thead>
            <tr>
              {["เดือน","เทรด","ชนะ","อัตราชนะ","P&L"].map(h => (
                <th key={h} style={{
                  textAlign: h === "Month" ? "left" : "right",
                  padding:"8px 12px",
                  fontSize:11, color:"#64748b", letterSpacing:"0.06em",
                  borderBottom:"1px solid rgba(0,0,0,0.05)", fontWeight:600,
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {analytics?.monthly.length ? analytics.monthly.map((m, i) => (
              <tr key={m.month} style={{
                background: i % 2 === 0 ? "rgba(0,0,0,0.02)" : "transparent",
                borderBottom: "1px solid rgba(0,0,0,0.03)",
              }}>
                <td style={{ padding:"10px 12px", fontWeight:600, color:"#1e293b" }}>
                  {monthLabel(m.month)}
                </td>
                <td style={{ padding:"10px 12px", textAlign:"right", color:"#64748b" }}>
                  {m.total}
                </td>
                <td style={{ padding:"10px 12px", textAlign:"right", color:"#64748b" }}>
                  {m.wins}
                </td>
                <td style={{ padding:"10px 12px", textAlign:"right" }}>
                  <span style={{
                    padding:"2px 10px", borderRadius:20, fontSize:11, fontWeight:600,
                    background: m.win_rate >= 60 ? "rgba(16,185,129,0.15)"
                      : m.win_rate >= 50 ? "rgba(245,158,11,0.15)"
                      : "rgba(239,68,68,0.15)",
                    color: m.win_rate >= 60 ? "#10b981"
                      : m.win_rate >= 50 ? "#f59e0b" : "#ef4444",
                  }}>
                    {fmtPct(m.win_rate)}
                  </span>
                </td>
                <td style={{
                  padding:"10px 12px", textAlign:"right", fontWeight:700,
                  color: m.pnl >= 0 ? "#10b981" : "#ef4444",
                }}>
                  {fmtUsd(m.pnl)}
                </td>
              </tr>
            )) : (
              <tr>
                <td colSpan={5} style={{ padding:"24px 12px",
                  textAlign:"center", color:"#64748b", fontSize:12 }}>
                  ไม่มีข้อมูล — รัน{" "}
                  <code style={{ color:"#64748b" }}>python tools/seed_demo_data.py</code>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}
