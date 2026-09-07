"use client";
import { useEffect, useState } from "react";
import ThbAmount from "../../../components/ThbAmount";

const GW = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";

type Tier = { label: string; icon: string; color: string; thb: number };
type DayData = {
  date: string; pnl_usd: number; pnl_thb: number;
  trades: number; wins: number; hit_target: boolean;
  tier: Tier | null;
};
type THBConfig = {
  thb_per_usd: number; daily_target_thb: number;
  mission_tiers: Tier[];
};

const DAYS_TH   = ["จ", "อ", "พ", "พฤ", "ศ", "ส", "อา"];
const MONTHS_TH = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
                   "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

function TodayMission({ today, cfg }: { today: DayData | undefined; cfg: THBConfig }) {
  const pnl      = today?.pnl_thb ?? 0;
  const target   = cfg.daily_target_thb;
  const tier     = today?.tier ?? null;
  const tiers    = cfg.mission_tiers ?? [];
  const nextTier = tiers.find(t => pnl < t.thb);
  const pct      = Math.min(100, pnl > 0 ? Math.round(pnl / target * 100) : 0);

  return (
    <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 16,
      padding: "20px 24px", marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: "#64748b", textTransform: "uppercase" as const,
            letterSpacing: "0.12em", marginBottom: 6 }}>🎯 Today&apos;s Mission</div>
          {tier ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 28 }}>{tier.icon}</span>
              <div>
                <div style={{ fontSize: 18, fontWeight: 900, color: tier.color }}>{tier.label}!</div>
                <div style={{ fontSize: 10, color: "#64748b" }}>
                  {nextTier ? `ถัดไป: ${nextTier.icon} ${nextTier.label} ที่ ฿${nextTier.thb.toLocaleString()}` : "🏅 สูงสุดแล้ว!"}
                </div>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: pnl > 0 ? "#10b981" : "#94a3b8" }}>
                {pnl > 0 ? `ใกล้แล้ว! เหลืออีก ฿${(target - pnl).toLocaleString()}` : "ยังไม่มี trade วันนี้"}
              </div>
              <div style={{ fontSize: 10, color: "#64748b" }}>เป้า Mission: ฿{target.toLocaleString()}</div>
            </div>
          )}
        </div>
        <div style={{ textAlign: "right" as const }}>
          <div style={{ fontSize: 9, color: "#64748b", marginBottom: 4 }}>วันนี้</div>
          <ThbAmount value={pnl} size="xl" showSign />
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#94a3b8", marginBottom: 4 }}>
          <span>฿0</span>
          {tiers.map(t => (
            <span key={t.label} style={{ color: pnl >= t.thb ? t.color : "#94a3b8" }}>
              {t.icon} ฿{(t.thb / 1000).toFixed(0)}k
            </span>
          ))}
        </div>
        <div style={{ height: 10, background: "#f1f5f9", borderRadius: 5, overflow: "hidden", position: "relative" as const }}>
          {/* Tier markers */}
          {tiers.map(t => {
            const maxTier = tiers[tiers.length - 1].thb;
            const pos = Math.round(t.thb / maxTier * 100);
            return (
              <div key={t.label} style={{
                position: "absolute" as const, left: `${pos}%`, top: 0, bottom: 0,
                width: 2, background: "#e2e8f0", zIndex: 1,
              }} />
            );
          })}
          {/* Progress fill */}
          {pnl > 0 && (
            <div style={{
              height: "100%",
              width: `${Math.min(100, pnl / tiers[tiers.length - 1].thb * 100)}%`,
              borderRadius: 5, transition: "width 0.5s ease",
              background: tier
                ? `linear-gradient(90deg,#10b981,${tier.color})`
                : "linear-gradient(90deg,#10b981,#6ee7b7)",
            }} />
          )}
        </div>
      </div>

      {/* Tier badges */}
      <div style={{ display: "flex", gap: 8 }}>
        {tiers.map(t => (
          <div key={t.label} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 10, fontWeight: 700,
            background: pnl >= t.thb ? `${t.color}18` : "#f8fafc",
            color: pnl >= t.thb ? t.color : "#94a3b8",
            border: `1.5px solid ${pnl >= t.thb ? t.color + "40" : "rgba(0,0,0,0.06)"}`,
          }}>
            {t.icon} {t.label} <span style={{ fontFamily: "var(--font-mono,monospace)", fontSize: 9 }}>฿{t.thb.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CalendarPage() {
  const [days,    setDays]    = useState<DayData[]>([]);
  const [cfg,     setCfg]     = useState<THBConfig>({
    thb_per_usd: 35, daily_target_thb: 3000,
    mission_tiers: [
      { label: "Mission",     icon: "✅", color: "#10b981", thb: 3000  },
      { label: "Outstanding", icon: "🌟", color: "#6366f1", thb: 5000  },
      { label: "Champion",    icon: "🏆", color: "#f59e0b", thb: 10000 },
      { label: "Legend",      icon: "💎", color: "#ec4899", thb: 20000 },
    ],
  });
  const [months,  setMonths]  = useState(3);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`${GW}/analytics/calendar?months=${months}`).then(r => r.json()),
      fetch(`${GW}/analytics/thb`).then(r => r.json()),
    ]).then(([d, c]) => {
      setDays(Array.isArray(d) ? d : []);
      setCfg(c);
      setLoading(false);
    });
  }, [months]);

  const byDate: Record<string, DayData> = {};
  days.forEach(d => { byDate[d.date] = d; });

  const todayStr    = new Date().toISOString().slice(0, 10);
  const todayData   = byDate[todayStr];
  const totalPnlThb = days.reduce((s, d) => s + d.pnl_thb, 0);
  const greenDays   = days.filter(d => d.pnl_thb > 0).length;
  const missionDays = days.filter(d => d.hit_target).length;
  const legendDays  = days.filter(d => d.tier?.label === "Legend").length;

  const now = new Date();
  const calMonths: { year: number; month: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    calMonths.push({ year: d.getFullYear(), month: d.getMonth() });
  }

  return (
    <div style={{ padding: "28px 32px 60px", background: "#f8fafc", minHeight: "100vh" }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 9, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.15em", marginBottom: 6 }}>POLIS Trading</div>
          <div style={{ fontSize: 26, fontWeight: 900, color: "#0f172a", letterSpacing: "-0.03em" }}>📅 Mission Calendar</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4, display: "flex", alignItems: "center", gap: 6 }}>
            Mission ขั้นต่ำ <ThbAmount value={cfg.daily_target_thb} size="sm" color="#10b981" />
            <span>· {cfg.thb_per_usd.toFixed(2)} บาท/USD</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {[1, 2, 3, 6].map(m => (
            <button key={m} type="button" onClick={() => setMonths(m)} style={{
              padding: "6px 14px", borderRadius: 8, fontSize: 11, fontWeight: 700,
              cursor: "pointer", border: `1.5px solid ${months === m ? "#6366f1" : "rgba(0,0,0,0.1)"}`,
              background: months === m ? "#6366f1" : "#fff", color: months === m ? "#fff" : "#475569",
            }}>{m} เดือน</button>
          ))}
        </div>
      </div>

      {/* Today's Mission Progress */}
      <TodayMission today={todayData} cfg={cfg} />

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 24 }}>
        <div style={{ background: `linear-gradient(135deg,${totalPnlThb >= 0 ? "#10b981" : "#ef4444"}08,#fff)`,
          border: `1px solid ${totalPnlThb >= 0 ? "#10b981" : "#ef4444"}22`, borderRadius: 14, padding: "16px 20px" }}>
          <div style={{ fontSize: 9, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 8 }}>รวม P&L</div>
          <ThbAmount value={totalPnlThb} size="lg" showSign />
        </div>
        <div style={{ background: "linear-gradient(135deg,#10b98108,#fff)", border: "1px solid #10b98122", borderRadius: 14, padding: "16px 20px" }}>
          <div style={{ fontSize: 9, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 8 }}>วันที่กำไร</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#10b981", fontFamily: "var(--font-mono,monospace)" }}>
            {greenDays}<span style={{ fontSize: 13, color: "#64748b" }}>/{days.length} วัน</span>
          </div>
        </div>
        <div style={{ background: "linear-gradient(135deg,#6366f108,#fff)", border: "1px solid #6366f122", borderRadius: 14, padding: "16px 20px" }}>
          <div style={{ fontSize: 9, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 8 }}>✅ Mission Complete</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#6366f1", fontFamily: "var(--font-mono,monospace)" }}>
            {missionDays}<span style={{ fontSize: 13, color: "#64748b" }}> วัน</span>
          </div>
        </div>
        <div style={{ background: "linear-gradient(135deg,#ec489908,#fff)", border: "1px solid #ec489922", borderRadius: 14, padding: "16px 20px" }}>
          <div style={{ fontSize: 9, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 8 }}>💎 Legend Days</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#ec4899", fontFamily: "var(--font-mono,monospace)" }}>
            {legendDays}<span style={{ fontSize: 13, color: "#64748b" }}> วัน</span>
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ color: "#94a3b8", fontSize: 13 }}>กำลังโหลด…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 24 }}>
          {calMonths.map(({ year, month }) => {
            const firstDay = new Date(year, month, 1);
            const lastDay  = new Date(year, month + 1, 0);
            const startDow = (firstDay.getDay() + 6) % 7;
            const cells: (number | null)[] = [
              ...Array(startDow).fill(null),
              ...Array.from({ length: lastDay.getDate() }, (_, i) => i + 1),
            ];
            while (cells.length % 7 !== 0) cells.push(null);

            const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
            const monthPnl = days.filter(d => d.date.startsWith(monthKey)).reduce((s, d) => s + d.pnl_thb, 0);

            return (
              <div key={monthKey} style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 16, padding: "20px 24px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#0f172a" }}>
                    {MONTHS_TH[month]} {year + 543}
                  </div>
                  <ThbAmount value={monthPnl} size="md" showSign />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3, marginBottom: 3 }}>
                  {DAYS_TH.map(d => (
                    <div key={d} style={{ textAlign: "center" as const, fontSize: 9, color: "#94a3b8", fontWeight: 700, padding: "2px 0" }}>{d}</div>
                  ))}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3 }}>
                  {cells.map((day, i) => {
                    if (!day) return <div key={i} />;
                    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                    const data    = byDate[dateStr];
                    const isToday = dateStr === todayStr;
                    const tier    = data?.tier ?? null;

                    // Background color based on tier
                    const bg = data
                      ? tier
                        ? tier.label === "Legend"      ? "#fdf4ff"
                        : tier.label === "Champion"    ? "#fffbeb"
                        : tier.label === "Outstanding" ? "#f0f0ff"
                        : "#f0fdf4"   // Mission
                        : data.pnl_thb < 0 ? "#fef2f2" : "#f8fafc"
                      : "#f8fafc";

                    const textCol = data
                      ? tier ? tier.color
                      : data.pnl_thb < 0 ? "#dc2626" : "#64748b"
                      : "#94a3b8";

                    const absThb  = Math.abs(data?.pnl_thb ?? 0);
                    const thbStr  = absThb >= 1000
                      ? `${(data!.pnl_thb >= 0 ? "+" : "-")}฿${(absThb / 1000).toFixed(1)}k`
                      : `${(data!.pnl_thb >= 0 ? "+" : "-")}฿${absThb}`;

                    return (
                      <div key={i} title={data ? `${tier ? tier.icon + " " + tier.label : ""} ฿${data.pnl_thb.toLocaleString()} · ${data.trades} trades` : ""} style={{
                        background: bg, borderRadius: 8, padding: "5px 3px",
                        textAlign: "center" as const, minHeight: 56,
                        border: isToday ? "2px solid #6366f1"
                          : tier ? `1px solid ${tier.color}30` : "1px solid transparent",
                        cursor: data ? "pointer" : "default",
                      }}>
                        <div style={{ fontSize: 9, color: isToday ? "#6366f1" : textCol, fontWeight: isToday ? 800 : 500, marginBottom: 2 }}>{day}</div>
                        {data && (
                          <>
                            {tier && <div style={{ fontSize: 11, lineHeight: 1 }}>{tier.icon}</div>}
                            <div style={{ fontSize: 8, fontWeight: 800, color: textCol,
                              fontFamily: "var(--font-mono,monospace)", lineHeight: 1.2, marginTop: 1 }}>
                              {thbStr}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
