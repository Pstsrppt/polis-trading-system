"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import ThbAmount from "../../../components/ThbAmount";

const GW    = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";
const GWWS  = process.env.NEXT_PUBLIC_GATEWAY_WS  ?? "ws://localhost:19000/ws/feed";

type Trade = {
  id: number; symbol: string; direction: string;
  entry_price: number; exit_price: number; lots: number;
  pnl_usd: number; pnl_thb: number; trade_result: string;
  confidence: number; created_at: string; exit_at: string;
};
type THBConfig = { thb_per_usd: number; daily_target_thb: number };

const SYM_COLOR: Record<string, string> = {
  XAUUSD: "#f59e0b", EURUSD: "#6366f1", GBPUSD: "#ec4899",
  BTCUSD: "#f97316", XAGUSD: "#94a3b8",
};

function fmtPrice(v: number) {
  if (!v) return "—";
  if (v < 10)   return v.toFixed(5);
  if (v < 1000) return v.toFixed(2);
  return v.toLocaleString("en", { maximumFractionDigits: 0 });
}

function fmtDuration(created: string, exited: string): string {
  if (!created || !exited) return "—";
  const ms = new Date(exited).getTime() - new Date(created).getTime();
  if (ms < 0) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function calcStreak(trades: Trade[]): { count: number; type: "WIN" | "LOSS" | null } {
  if (!trades.length) return { count: 0, type: null };
  const sorted = [...trades].sort((a, b) => new Date(b.exit_at || b.created_at).getTime() - new Date(a.exit_at || a.created_at).getTime());
  const first = sorted[0].trade_result as "WIN" | "LOSS";
  let count = 0;
  for (const t of sorted) {
    if (t.trade_result === first) count++;
    else break;
  }
  return { count, type: first };
}

function isToday(dateStr: string): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
}

function LiveDot() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{
        width: 7, height: 7, borderRadius: "50%", background: "#10b981",
        boxShadow: "0 0 0 0 #10b981",
        animation: "livepulse 1.5s ease-in-out infinite",
        display: "inline-block",
      }} />
      <style>{`@keyframes livepulse{0%,100%{box-shadow:0 0 0 0 #10b98155}50%{box-shadow:0 0 0 5px #10b98100}}`}</style>
      <span style={{ fontSize: 9, color: "#10b981", fontWeight: 700, letterSpacing: "0.08em" }}>LIVE</span>
    </span>
  );
}

export default function TradeLogPage() {
  const [trades,     setTrades]     = useState<Trade[]>([]);
  const [cfg,        setCfg]        = useState<THBConfig>({ thb_per_usd: 35, daily_target_thb: 3000 });
  const [loading,    setLoading]    = useState(true);
  const [filter,     setFilter]     = useState<"all" | "WIN" | "LOSS">("all");
  const [symFilter,  setSymFilter]  = useState<string>("ALL");
  const [todayOnly,  setTodayOnly]  = useState(false);
  const [page,       setPage]       = useState(0);
  const [lastUpdate, setLastUpdate] = useState("");
  const [newFlash,   setNewFlash]   = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const PAGE = 50;

  const load = useCallback(async () => {
    const [t, c] = await Promise.all([
      fetch(`${GW}/analytics/trades?limit=500`).then(r => r.json()),
      fetch(`${GW}/analytics/thb`).then(r => r.json()),
    ]);
    setTrades(Array.isArray(t) ? t : []);
    setCfg(c);
    setLoading(false);
    setLastUpdate(new Date().toLocaleTimeString("th-TH"));
  }, []);

  useEffect(() => {
    load();

    function connect() {
      const ws = new WebSocket(GWWS);
      wsRef.current = ws;
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.topic === "TRADE_CLOSED") {
            load().then(() => {
              const id = msg.data?.id as number;
              if (id) {
                setNewFlash(id);
                setTimeout(() => setNewFlash(null), 3000);
              }
              setPage(0);
            });
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => setTimeout(connect, 3000);
    }
    connect();

    const t = setInterval(load, 30_000);
    return () => {
      clearInterval(t);
      wsRef.current?.close();
    };
  }, [load]);

  const filtered = trades.filter(t =>
    (filter === "all" || t.trade_result === filter) &&
    (symFilter === "ALL" || t.symbol === symFilter) &&
    (!todayOnly || isToday(t.exit_at || t.created_at))
  );
  const paged        = filtered.slice(page * PAGE, (page + 1) * PAGE);
  const totalPnlThb  = filtered.reduce((s, t) => s + (t.pnl_thb || 0), 0);
  const wins         = filtered.filter(t => t.trade_result === "WIN");
  const losses       = filtered.filter(t => t.trade_result === "LOSS");
  const totalWinThb  = wins.reduce((s, t) => s + (t.pnl_thb || 0), 0);
  const totalLossThb = Math.abs(losses.reduce((s, t) => s + (t.pnl_thb || 0), 0));
  const profitFactor = totalLossThb > 0 ? totalWinThb / totalLossThb : totalWinThb > 0 ? Infinity : 0;
  const avgPnlThb    = filtered.length > 0 ? totalPnlThb / filtered.length : 0;
  const streak       = calcStreak(filtered);
  const symbols      = ["ALL", ...Array.from(new Set(trades.map(t => t.symbol)))];
  const thbRate      = cfg.thb_per_usd;

  // Today progress
  const todayTrades  = trades.filter(t => isToday(t.exit_at || t.created_at));
  const todayPnlThb  = todayTrades.reduce((s, t) => s + (t.pnl_thb || 0), 0);
  const todayProgress = Math.min(100, Math.max(0, (todayPnlThb / cfg.daily_target_thb) * 100));

  return (
    <div style={{ padding: "28px 32px 60px", background: "#f8fafc", minHeight: "100vh" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 9, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: 6 }}>POLIS Trading</div>
          <div style={{ fontSize: 26, fontWeight: 900, color: "#0f172a", letterSpacing: "-0.03em", display: "flex", alignItems: "center", gap: 12 }}>
            📋 Trade Log <LiveDot />
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
            อัปเดตอัตโนมัติทุก trade · {thbRate.toFixed(2)} บาท/USD
            {lastUpdate && <span style={{ marginLeft: 8, color: "#94a3b8" }}>· อัปเดต {lastUpdate}</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" onClick={load} style={{
            padding: "7px 14px", borderRadius: 8, fontSize: 11, fontWeight: 700,
            background: "#fff", border: "1px solid rgba(0,0,0,0.1)", cursor: "pointer", color: "#475569",
          }}>🔄 Refresh</button>
          <a href={`${GW}/trades/export.csv`} download style={{
            padding: "9px 18px", borderRadius: 10, fontSize: 12, fontWeight: 700,
            background: "linear-gradient(135deg,#10b981,#059669)",
            color: "#fff", textDecoration: "none",
          }}>⬇️ Export CSV</a>
        </div>
      </div>

      {/* Today Progress Bar */}
      <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 12, padding: "12px 16px", marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>
            🎯 เป้าวันนี้
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 11, color: "#64748b" }}>
              {todayTrades.length} trade · {Math.round(todayProgress)}%
            </span>
            <span style={{ fontSize: 13, fontWeight: 900, color: todayPnlThb >= 0 ? "#10b981" : "#ef4444" }}>
              {todayPnlThb >= 0 ? "+" : ""}฿{todayPnlThb.toLocaleString("th-TH", { maximumFractionDigits: 0 })}
              <span style={{ fontSize: 10, fontWeight: 400, color: "#94a3b8", marginLeft: 6 }}>
                / ฿{cfg.daily_target_thb.toLocaleString("th-TH")}
              </span>
            </span>
          </div>
        </div>
        <div style={{ height: 6, background: "#f1f5f9", borderRadius: 99, overflow: "hidden" }}>
          <div style={{
            height: "100%", borderRadius: 99, transition: "width 0.5s ease",
            width: `${todayProgress}%`,
            background: todayPnlThb < 0
              ? "#ef4444"
              : todayProgress >= 100
              ? "linear-gradient(90deg,#10b981,#059669)"
              : "linear-gradient(90deg,#6366f1,#8b5cf6)",
          }} />
        </div>
      </div>

      {/* Summary Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 10, marginBottom: 20 }}>
        {/* Total */}
        <div style={{ background: "linear-gradient(135deg,#6366f108,#fff)", border: "1px solid #6366f122", borderRadius: 12, padding: "12px 14px" }}>
          <div style={{ fontSize: 8, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 6 }}>Trades</div>
          <div style={{ fontSize: 20, fontWeight: 900, color: "#6366f1", fontFamily: "var(--font-mono,monospace)" }}>{filtered.length}</div>
          <div style={{ fontSize: 9, color: "#94a3b8", marginTop: 2 }}>W {wins.length} / L {losses.length}</div>
        </div>
        {/* Win Rate */}
        <div style={{ background: "linear-gradient(135deg,#10b98108,#fff)", border: "1px solid #10b98122", borderRadius: 12, padding: "12px 14px" }}>
          <div style={{ fontSize: 8, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 6 }}>Win Rate</div>
          <div style={{ fontSize: 20, fontWeight: 900, color: "#10b981", fontFamily: "var(--font-mono,monospace)" }}>
            {filtered.length > 0 ? Math.round(wins.length / filtered.length * 100) : 0}%
          </div>
        </div>
        {/* Profit Factor */}
        <div style={{ background: "linear-gradient(135deg,#8b5cf608,#fff)", border: "1px solid #8b5cf622", borderRadius: 12, padding: "12px 14px" }}>
          <div style={{ fontSize: 8, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 6 }}>Profit Factor</div>
          <div style={{ fontSize: 20, fontWeight: 900, color: "#8b5cf6", fontFamily: "var(--font-mono,monospace)" }}>
            {profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}
          </div>
          <div style={{ fontSize: 9, color: profitFactor >= 1.5 ? "#10b981" : profitFactor >= 1 ? "#f59e0b" : "#ef4444", marginTop: 2, fontWeight: 700 }}>
            {profitFactor >= 1.5 ? "ดีมาก" : profitFactor >= 1 ? "พอใช้" : "ขาดทุน"}
          </div>
        </div>
        {/* Total P&L */}
        <div style={{ background: `linear-gradient(135deg,${totalPnlThb >= 0 ? "#10b981" : "#ef4444"}08,#fff)`, border: `1px solid ${totalPnlThb >= 0 ? "#10b981" : "#ef4444"}22`, borderRadius: 12, padding: "12px 14px" }}>
          <div style={{ fontSize: 8, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 6 }}>รวม P&L</div>
          <ThbAmount value={totalPnlThb} size="lg" showSign />
        </div>
        {/* Avg P&L */}
        <div style={{ background: `linear-gradient(135deg,${avgPnlThb >= 0 ? "#f59e0b" : "#ef4444"}08,#fff)`, border: `1px solid ${avgPnlThb >= 0 ? "#f59e0b" : "#ef4444"}22`, borderRadius: 12, padding: "12px 14px" }}>
          <div style={{ fontSize: 8, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 6 }}>Avg / Trade</div>
          <ThbAmount value={avgPnlThb} size="lg" showSign />
        </div>
        {/* Streak */}
        <div style={{ background: `linear-gradient(135deg,${streak.type === "WIN" ? "#10b981" : streak.type === "LOSS" ? "#ef4444" : "#6366f1"}08,#fff)`, border: `1px solid ${streak.type === "WIN" ? "#10b981" : streak.type === "LOSS" ? "#ef4444" : "#6366f1"}22`, borderRadius: 12, padding: "12px 14px" }}>
          <div style={{ fontSize: 8, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 6 }}>Streak</div>
          <div style={{ fontSize: 20, fontWeight: 900, fontFamily: "var(--font-mono,monospace)", color: streak.type === "WIN" ? "#10b981" : streak.type === "LOSS" ? "#ef4444" : "#94a3b8" }}>
            {streak.type ? `${streak.type === "WIN" ? "🔥" : "💀"} ${streak.count}` : "—"}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" as const, alignItems: "center" }}>
        {(["all", "WIN", "LOSS"] as const).map(f => (
          <button key={f} type="button" onClick={() => { setFilter(f); setPage(0); }} style={{
            padding: "5px 14px", borderRadius: 20, fontSize: 11, fontWeight: 700, cursor: "pointer",
            border: `1.5px solid ${filter === f ? (f === "WIN" ? "#10b981" : f === "LOSS" ? "#ef4444" : "#6366f1") : "rgba(0,0,0,0.1)"}`,
            background: filter === f ? (f === "WIN" ? "#10b98118" : f === "LOSS" ? "#ef444418" : "#6366f118") : "#fff",
            color: filter === f ? (f === "WIN" ? "#10b981" : f === "LOSS" ? "#ef4444" : "#6366f1") : "#64748b",
          }}>{f === "all" ? "ทั้งหมด" : f}</button>
        ))}

        {/* Today toggle */}
        <button type="button" onClick={() => { setTodayOnly(v => !v); setPage(0); }} style={{
          padding: "5px 14px", borderRadius: 20, fontSize: 11, fontWeight: 700, cursor: "pointer",
          border: `1.5px solid ${todayOnly ? "#f59e0b" : "rgba(0,0,0,0.1)"}`,
          background: todayOnly ? "#f59e0b18" : "#fff",
          color: todayOnly ? "#f59e0b" : "#64748b",
        }}>📅 วันนี้</button>

        <div style={{ width: 1, background: "rgba(0,0,0,0.1)", margin: "0 4px", height: 20 }} />

        {symbols.map(s => (
          <button key={s} type="button" onClick={() => { setSymFilter(s); setPage(0); }} style={{
            padding: "5px 14px", borderRadius: 20, fontSize: 11, fontWeight: 700, cursor: "pointer",
            border: `1.5px solid ${symFilter === s ? (SYM_COLOR[s] ?? "#6366f1") : "rgba(0,0,0,0.1)"}`,
            background: symFilter === s ? `${SYM_COLOR[s] ?? "#6366f1"}18` : "#fff",
            color: symFilter === s ? (SYM_COLOR[s] ?? "#6366f1") : "#64748b",
          }}>{s}</button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ color: "#94a3b8", fontSize: 13 }}>กำลังโหลด…</div>
      ) : (
        <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 16, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" as const }}>
            <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(0,0,0,0.06)", background: "#f8fafc" }}>
                  {["#", "วันที่", "Symbol", "ทิศทาง", "Entry", "Exit", "Lots", "Duration", "P&L (USD)", "P&L (THB)", "Conf.", "ผล"].map(h => (
                    <th key={h} style={{ padding: "10px 12px", textAlign: "left" as const, color: "#64748b", fontWeight: 700, fontSize: 9, textTransform: "uppercase" as const, letterSpacing: "0.08em", whiteSpace: "nowrap" as const }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.length === 0 ? (
                  <tr>
                    <td colSpan={12} style={{ padding: "40px", textAlign: "center" as const, color: "#94a3b8", fontSize: 12 }}>
                      ยังไม่มี trade ที่ปิดแล้ว — ระบบกำลังทำงานอยู่
                    </td>
                  </tr>
                ) : paged.map(t => {
                  const win   = t.trade_result === "WIN";
                  const c     = win ? "#10b981" : "#ef4444";
                  const symC  = SYM_COLOR[t.symbol] ?? "#6366f1";
                  const isNew = newFlash === t.id;
                  const dur   = fmtDuration(t.created_at, t.exit_at);
                  return (
                    <tr key={t.id} style={{
                      borderBottom: "1px solid rgba(0,0,0,0.04)",
                      background: isNew ? "rgba(16,185,129,0.06)" : undefined,
                      transition: "background 0.5s",
                    }}>
                      <td style={{ padding: "8px 12px", color: "#94a3b8", fontSize: 9 }}>#{t.id}</td>
                      <td style={{ padding: "8px 12px", color: "#64748b", fontSize: 9, whiteSpace: "nowrap" as const }}>
                        {t.exit_at ? new Date(t.exit_at).toLocaleString("th-TH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, background: `${symC}15`, color: symC, fontWeight: 700 }}>{t.symbol}</span>
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 5, fontWeight: 700,
                          background: t.direction === "long" ? "#10b98115" : "#ef444415",
                          color: t.direction === "long" ? "#10b981" : "#ef4444" }}>
                          {t.direction === "long" ? "▲ LONG" : "▼ SHORT"}
                        </span>
                      </td>
                      <td style={{ padding: "8px 12px", fontFamily: "var(--font-mono,monospace)", fontSize: 10 }}>{fmtPrice(t.entry_price)}</td>
                      <td style={{ padding: "8px 12px", fontFamily: "var(--font-mono,monospace)", fontSize: 10 }}>{fmtPrice(t.exit_price)}</td>
                      <td style={{ padding: "8px 12px", color: "#64748b" }}>{t.lots?.toFixed(2)}</td>
                      <td style={{ padding: "8px 12px", color: "#94a3b8", fontSize: 9, whiteSpace: "nowrap" as const }}>{dur}</td>
                      <td style={{ padding: "8px 12px", fontWeight: 700, color: c, fontFamily: "var(--font-mono,monospace)" }}>
                        {t.pnl_usd >= 0 ? "+" : ""}${t.pnl_usd?.toFixed(2)}
                      </td>
                      <td style={{ padding: "8px 12px" }}>
                        <ThbAmount value={t.pnl_thb ?? 0} size="sm" showSign />
                      </td>
                      <td style={{ padding: "8px 12px", color: "#64748b" }}>{t.confidence}%</td>
                      <td style={{ padding: "8px 12px" }}>
                        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 6, fontWeight: 700, background: `${c}18`, color: c }}>
                          {win ? "✅ WIN" : "❌ LOSS"}
                        </span>
                        {isNew && <span style={{ marginLeft: 6, fontSize: 8, color: "#10b981", fontWeight: 700 }}>NEW</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderTop: "1px solid rgba(0,0,0,0.06)" }}>
            <div style={{ fontSize: 10, color: "#64748b" }}>
              แสดง {Math.min(page * PAGE + 1, filtered.length)}–{Math.min((page + 1) * PAGE, filtered.length)} จาก {filtered.length} รายการ
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={{
                padding: "5px 14px", borderRadius: 7, fontSize: 11, fontWeight: 700,
                cursor: page === 0 ? "not-allowed" : "pointer",
                background: page === 0 ? "#f1f5f9" : "#fff", color: page === 0 ? "#94a3b8" : "#475569",
                border: "1px solid rgba(0,0,0,0.1)",
              }}>← ก่อนหน้า</button>
              <button type="button" onClick={() => setPage(p => p + 1)} disabled={(page + 1) * PAGE >= filtered.length} style={{
                padding: "5px 14px", borderRadius: 7, fontSize: 11, fontWeight: 700,
                cursor: (page + 1) * PAGE >= filtered.length ? "not-allowed" : "pointer",
                background: (page + 1) * PAGE >= filtered.length ? "#f1f5f9" : "#fff",
                color: (page + 1) * PAGE >= filtered.length ? "#94a3b8" : "#475569",
                border: "1px solid rgba(0,0,0,0.1)",
              }}>ถัดไป →</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
