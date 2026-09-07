"use client";
import { useEffect, useState } from "react";
import ThbAmount from "../../../components/ThbAmount";

const GW = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";

type HourData = { hour: number; trades: number; wins: number; pnl_usd: number; pnl_thb: number; win_rate: number };
type THBConfig = { thb_per_usd: number; daily_target_thb: number };

export default function BestHoursPage() {
  const [hours,   setHours]   = useState<HourData[]>([]);
  const [cfg,     setCfg]     = useState<THBConfig>({ thb_per_usd: 35, daily_target_thb: 500 });
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [applyMsg, setApplyMsg] = useState("");

  useEffect(() => {
    Promise.all([
      fetch(`${GW}/analytics/hours`).then(r => r.json()),
      fetch(`${GW}/analytics/thb`).then(r => r.json()),
    ]).then(([h, c]) => {
      setHours(Array.isArray(h) ? h : []);
      setCfg(c);
      setLoading(false);
    });
  }, []);

  const applyBestHours = async () => {
    if (!confirm("ใช้ชั่วโมงที่ดีที่สุดเป็น trading hours ใหม่ไหมครับ? (kernel จะรับทันทีไม่ต้อง restart)")) return;
    setApplying(true); setApplyMsg("");
    try {
      const r = await fetch(`${GW}/analytics/hours/apply-best`, { method: "POST" });
      const d = await r.json();
      if (r.ok) {
        setApplyMsg(`✅ ${d.message} — ${d.good_hours.map((h: number) => `${String(h).padStart(2,"0")}:00`).join(", ")}`);
      } else {
        setApplyMsg(`❌ ${d.detail}`);
      }
    } catch { setApplyMsg("❌ ไม่สามารถเชื่อมต่อได้"); }
    finally { setApplying(false); }
  };

  const maxPnl     = Math.max(...hours.map(h => Math.abs(h.pnl_thb)), 1);
  const bestHours  = [...hours].sort((a, b) => b.pnl_thb - a.pnl_thb).slice(0, 3);
  const worstHours = [...hours].sort((a, b) => a.pnl_thb - b.pnl_thb).slice(0, 3);

  // Full 24h grid
  const all24 = Array.from({ length: 24 }, (_, i) => hours.find(h => h.hour === i) ?? null);

  return (
    <div style={{ padding: "28px 32px 60px", background: "#f8fafc", minHeight: "100vh" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28 }}>
        <div>
          <div style={{ fontSize: 9, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: 6 }}>POLIS Trading</div>
          <div style={{ fontSize: 26, fontWeight: 900, color: "#0f172a", letterSpacing: "-0.03em" }}>⏰ Best Hours Analysis</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>วิเคราะห์ผลเทรดรายชั่วโมง UTC · {cfg.thb_per_usd} บาท/USD</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "flex-end", gap: 8 }}>
          <button type="button" onClick={applyBestHours} disabled={applying || loading} style={{
            padding: "9px 20px", borderRadius: 10, fontSize: 12, fontWeight: 700,
            cursor: applying ? "not-allowed" : "pointer",
            background: applying ? "#e2e8f0" : "linear-gradient(135deg,#6366f1,#818cf8)",
            color: applying ? "#94a3b8" : "#fff", border: "none",
            boxShadow: applying ? "none" : "0 4px 12px rgba(99,102,241,0.3)",
          }}>
            {applying ? "กำลังใช้…" : "⚡ Auto-Apply Best Hours"}
          </button>
          {applyMsg && (
            <div style={{ fontSize: 10, color: applyMsg.startsWith("✅") ? "#10b981" : "#ef4444",
              maxWidth: 280, textAlign: "right" as const }}>
              {applyMsg}
            </div>
          )}
        </div>
      </div>

      {loading ? <div style={{ color: "#94a3b8", fontSize: 13 }}>กำลังโหลด…</div> : (
        <>
          {/* Best/Worst summary */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
            <div style={{ background: "#fff", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 14, padding: "18px 20px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#10b981", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>🏆 เวลาทองที่สุด</div>
              {bestHours.map(h => (
                <div key={h.hour} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid rgba(0,0,0,0.04)" }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: "#0f172a", fontFamily: "var(--font-mono,monospace)" }}>
                    {String(h.hour).padStart(2, "0")}:00 UTC
                    <span style={{ fontSize: 9, color: "#64748b", marginLeft: 8 }}>({String((h.hour + 7) % 24).padStart(2, "0")}:00 BKK)</span>
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <ThbAmount value={h.pnl_thb} size="sm" showSign color="#10b981" />
                    <span style={{ fontSize: 9, color: "#64748b" }}>WR {h.win_rate}%</span>
                  </span>
                </div>
              ))}
            </div>
            <div style={{ background: "#fff", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 14, padding: "18px 20px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#ef4444", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>⚠️ เวลาที่แย่สุด</div>
              {worstHours.map(h => (
                <div key={h.hour} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid rgba(0,0,0,0.04)" }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: "#0f172a", fontFamily: "var(--font-mono,monospace)" }}>
                    {String(h.hour).padStart(2, "0")}:00 UTC
                    <span style={{ fontSize: 9, color: "#64748b", marginLeft: 8 }}>({String((h.hour + 7) % 24).padStart(2, "0")}:00 BKK)</span>
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <ThbAmount value={h.pnl_thb} size="sm" showSign color="#ef4444" />
                    <span style={{ fontSize: 9, color: "#64748b" }}>WR {h.win_rate}%</span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* 24h heatmap */}
          <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 16, padding: "20px 24px", marginBottom: 20 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 16 }}>Heatmap 24 ชั่วโมง (UTC)</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(24,1fr)", gap: 3 }}>
              {all24.map((h, i) => {
                const pct  = h ? Math.round(Math.abs(h.pnl_thb) / maxPnl * 100) : 0;
                const col  = h ? (h.pnl_thb >= 0 ? "#10b981" : "#ef4444") : "#f1f5f9";
                const bkkH = (i + 7) % 24;
                return (
                  <div key={i} title={h ? `${String(i).padStart(2,"0")}:00 UTC (${String(bkkH).padStart(2,"0")}:00 BKK)\n฿${h.pnl_thb.toLocaleString()} · ${h.trades} trades · WR ${h.win_rate}%` : `${String(i).padStart(2,"0")}:00 UTC`}
                    style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                    <div style={{ width: "100%", height: `${Math.max(8, pct)}px`, borderRadius: 3, background: h ? col : "#f1f5f9", maxHeight: 60, minHeight: 8 }} />
                    <div style={{ fontSize: 7, color: "#94a3b8", textAlign: "center" }}>{String(i).padStart(2,"0")}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, color: "#94a3b8", marginTop: 8 }}>
              <span>00:00 UTC (07:00 BKK)</span>
              <span>12:00 UTC (19:00 BKK)</span>
              <span>23:00 UTC (06:00 BKK+1)</span>
            </div>
          </div>

          {/* Detail table */}
          <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 16, padding: "20px 24px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 14 }}>รายละเอียดรายชั่วโมง</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid rgba(0,0,0,0.06)" }}>
                    {["UTC", "Bangkok", "Trades", "WR", "P&L (USD)", "P&L (THB)"].map(h => (
                      <th key={h} style={{ padding: "6px 12px", textAlign: "left", color: "#64748b", fontWeight: 700, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {hours.sort((a, b) => b.pnl_thb - a.pnl_thb).map(h => {
                    const c = h.pnl_thb >= 0 ? "#10b981" : "#ef4444";
                    return (
                      <tr key={h.hour} style={{ borderBottom: "1px solid rgba(0,0,0,0.04)" }}>
                        <td style={{ padding: "7px 12px", fontWeight: 700, fontFamily: "var(--font-mono,monospace)" }}>{String(h.hour).padStart(2,"0")}:00</td>
                        <td style={{ padding: "7px 12px", color: "#64748b", fontFamily: "var(--font-mono,monospace)" }}>{String((h.hour+7)%24).padStart(2,"0")}:00</td>
                        <td style={{ padding: "7px 12px" }}>{h.trades}</td>
                        <td style={{ padding: "7px 12px" }}>
                          <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 6, background: `${c}15`, color: c, fontWeight: 700 }}>{h.win_rate}%</span>
                        </td>
                        <td style={{ padding: "7px 12px", fontFamily: "var(--font-mono,monospace)", color: c, fontWeight: 700 }}>
                          {h.pnl_usd >= 0 ? "+" : ""}${h.pnl_usd.toFixed(0)}
                        </td>
                        <td style={{ padding: "7px 12px" }}>
                          <ThbAmount value={h.pnl_thb} size="sm" showSign />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
