"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";

const GW = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";
const WS = GW.replace(/^http/, "ws") + "/ws/feed";

type ServiceHealth = Record<string, string>;
type Stats = {
  total_pnl: number; today_pnl: number;
  win_rate: number; open_trades: number; equity_pts: number;
};
type FeedEvent = {
  topic: string; ts: string;
  data: Record<string, unknown>;
};

/* ── Topic meta ──────────────────────────────────────────────────────── */
const TOPIC_META: Record<string, { label: string; col: string; icon: string }> = {
  TRADE_SIGNAL:            { label: "Signal",    col: "#22d3ee", icon: "📡" },
  RESEARCH_COMPLETE:       { label: "Research",  col: "#818cf8", icon: "🔬" },
  SIGNAL_APPROVED:         { label: "Approved",  col: "#10b981", icon: "✅" },
  SIGNAL_REJECTED:         { label: "Rejected",  col: "#f59e0b", icon: "⛔" },
  TRADE_APPROVED:          { label: "Trade",     col: "#10b981", icon: "🚀" },
  TRADE_CLOSED:            { label: "Closed",    col: "#06b6d4", icon: "🔒" },
  POLICY_BLOCKED:          { label: "Blocked",   col: "#ef4444", icon: "🛑" },
  BOARD_RESOLUTION:        { label: "Board",     col: "#a855f7", icon: "🏢" },
  CIRCUIT_BREAKER_TRIGGERED:{ label: "CB Trip",  col: "#ef4444", icon: "⚡" },
  CIRCUIT_BREAKER_RESET:   { label: "CB Reset",  col: "#10b981", icon: "🔄" },
  HEALTH_TICK:             { label: "Health",    col: "#334155", icon: "💓" },
  WORLD_UPDATE:            { label: "World",     col: "#475569", icon: "🌍" },
};

const SKIP = new Set(["HEALTH_TICK", "WORLD_UPDATE", "PING"]);
const REGIME_OK = new Set(["RISK-ON","RISK-OFF","NEUTRAL","UNKNOWN"]);
const fmtPrice = (v: number) => v < 10 ? v.toFixed(5) : v < 1000 ? v.toFixed(2) : v.toFixed(0);

function eventSummary(topic: string, data: Record<string, unknown>): string {
  switch (topic) {
    case "TRADE_SIGNAL":
      return `${String(data.direction ?? "").toUpperCase()} ${data.symbol ?? ""} @ $${fmtPrice(Number(data.price ?? 0))}`;
    case "RESEARCH_COMPLETE":
      return `${data.symbol ?? ""} — ${(data.research as Record<string,unknown>)?.sentiment ?? ""} conf=${(data.research as Record<string,unknown>)?.confidence ?? "?"}%`;
    case "SIGNAL_APPROVED":
      return `${String(data.direction ?? "").toUpperCase()} ${data.symbol ?? ""} passed filter`;
    case "SIGNAL_REJECTED": {
      const reasons = data.rejected_reasons as string[] | undefined;
      return `${data.symbol ?? ""} — ${reasons?.[0] ?? "rejected"}`;
    }
    case "TRADE_APPROVED":
      return `${String(data.direction ?? "").toUpperCase()} ${data.symbol ?? ""} ${data.lots ?? ""}lot  conf=${data.confidence ?? "?"}%`;
    case "TRADE_CLOSED":
      return `${data.symbol ?? ""} ${data.result ?? ""}  P&L $${Number(data.pnl_usd ?? 0) >= 0 ? "+" : ""}${Number(data.pnl_usd ?? 0).toFixed(2)}`;
    case "POLICY_BLOCKED":
      return `${data.symbol ?? ""} — ${data.reason ?? "policy block"}`;
    case "BOARD_RESOLUTION":
      return `Resolution: ${String(data.resolution ?? "").toUpperCase()} — ${String(data.directive ?? "").slice(0, 60)}`;
    case "CIRCUIT_BREAKER_TRIGGERED":
      return `TRIGGERED — ${data.reason ?? ""}`;
    case "CIRCUIT_BREAKER_RESET":
      return "Circuit Breaker reset";
    default:
      return JSON.stringify(data).slice(0, 80);
  }
}

/* ── Atoms ───────────────────────────────────────────────────────────── */
function GlassCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "#ffffff",
      border: "1px solid rgba(0,0,0,0.07)", borderRadius: 18,
      boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 4px 16px rgba(0,0,0,0.04)",
      ...style,
    }}>{children}</div>
  );
}

function Dot({ col, pulse }: { col: string; pulse?: boolean }) {
  return (
    <div style={{ position: "relative", width: 8, height: 8, flexShrink: 0 }}>
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: col, boxShadow: `0 0 6px ${col}` }} />
      {pulse && (
        <div style={{
          position: "absolute", inset: -3, borderRadius: "50%",
          border: `1.5px solid ${col}`, animation: "ping 1.4s ease infinite", opacity: 0.6,
        }} />
      )}
    </div>
  );
}

function ServiceRow({ name, status, svcKey }: { name: string; status: string | undefined; svcKey?: string }) {
  const ok    = status === "ok" || (svcKey === "world_model" && REGIME_OK.has(status ?? ""));
  const col   = ok ? "#10b981" : status === "warn" ? "#f59e0b" : "#ef4444";
  const label = ok
    ? (svcKey === "world_model" && status !== "ok" ? status ?? "ใช้งาน" : "ออนไลน์")
    : status === "warn" ? "ลดลง" : "ออฟไลน์";
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(0,0,0,0.06)", fontSize: 11 }}>
      <span style={{ color: "#64748b" }}>{name}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Dot col={col} pulse={status === "ok"} />
        <span style={{ color: col, fontWeight: 700, fontSize: 10 }}>{label}</span>
      </div>
    </div>
  );
}

function DeptCard({ icon, name, sub, color, href, status, kpis }: {
  icon: string; name: string; sub: string; color: string;
  href: string; status: "live" | "soon";
  kpis?: { label: string; value: string; col?: string }[];
}) {
  const live = status === "live";
  const card = (
    <GlassCard style={{
      padding: "24px", cursor: live ? "pointer" : "default",
      border: `1px solid ${live ? color + "30" : "rgba(255,255,255,0.07)"}`,
      transition: "border-color 0.2s, transform 0.2s", opacity: live ? 1 : 0.55,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 28, marginBottom: 8 }}>{icon}</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.02em" }}>{name}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 3 }}>{sub}</div>
        </div>
        <div style={{
          padding: "4px 10px", borderRadius: 20, fontSize: 9, fontWeight: 800, letterSpacing: "0.1em",
          background: live ? `${color}18` : "rgba(255,255,255,0.04)",
          color: live ? color : "#334155",
          border: `1px solid ${live ? color + "35" : "rgba(255,255,255,0.06)"}`,
        }}>{live ? "LIVE" : "SOON"}</div>
      </div>
      {kpis && kpis.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${kpis.length},1fr)`, gap: 8, marginBottom: 18 }}>
          {kpis.map(k => (
            <div key={k.label} style={{ padding: "10px 12px", borderRadius: 10, background: "#f8fafc" }}>
              <div style={{ fontSize: 8, color: "#475569", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 3 }}>{k.label}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: k.col ?? "#e2e8f0", fontFamily: "var(--font-mono,monospace)" }}>{k.value}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {live ? <Dot col={color} pulse /> : <Dot col="#334155" />}
        <span style={{ fontSize: 10, color: live ? color : "#334155", fontWeight: 600 }}>
          {live ? `เปิด${name} →` : "เร็วๆ นี้"}
        </span>
      </div>
    </GlassCard>
  );
  return live ? <Link href={href} style={{ textDecoration: "none" }}>{card}</Link> : card;
}

function KpiPill({ icon, label, value, col }: { icon: string; label: string; value: string; col: string }) {
  return (
    <GlassCard style={{ padding: "16px 20px", background: `linear-gradient(135deg,${col}12,${col}06,transparent)`, border: `1px solid ${col}28` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 18, opacity: 0.8 }}>{icon}</span>
        <div>
          <div style={{ fontSize: 8, color: `${col}99`, letterSpacing: "0.1em", textTransform: "uppercase" as const, fontWeight: 700, marginBottom: 2 }}>{label}</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: col, fontFamily: "var(--font-mono,monospace)", lineHeight: 1 }}>{value}</div>
        </div>
      </div>
    </GlassCard>
  );
}

/* ── เหตุการณ์แบบเรียลไทม์ ─────────────────────────────────────────────────── */
function LiveFeed({ events, wsConnected }: { events: FeedEvent[]; wsConnected: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events]);

  return (
    <GlassCard style={{ padding: "20px 22px", display: "flex", flexDirection: "column", minHeight: 320 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: "#64748b", letterSpacing: "0.1em", textTransform: "uppercase" as const }}>
          ฟีดเหตุการณ์สด
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Dot col={wsConnected ? "#10b981" : "#ef4444"} pulse={wsConnected} />
          <span style={{ fontSize: 9, color: wsConnected ? "#10b981" : "#ef4444", fontWeight: 600 }}>
            {wsConnected ? "WebSocket เชื่อมต่อแล้ว" : "กำลังเชื่อมต่อ…"}
          </span>
        </div>
      </div>

      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, maxHeight: 320 }}
      >
        {events.length === 0 ? (
          <div style={{ color: "#94a3b8", fontSize: 11, padding: "20px 0", textAlign: "center" as const }}>
            รอเหตุการณ์จาก kernel…
          </div>
        ) : (
          events.map((ev, i) => {
            const meta = TOPIC_META[ev.topic] ?? { label: ev.topic, col: "#475569", icon: "•" };
            const summary = eventSummary(ev.topic, ev.data);
            const ts = new Date(ev.ts);
            const timeStr = ts.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
            return (
              <div key={i} style={{
                display: "flex", alignItems: "flex-start", gap: 8,
                padding: "7px 10px", borderRadius: 8,
                background: i === events.length - 1 ? `${meta.col}10` : "transparent",
                borderLeft: i === events.length - 1 ? `2px solid ${meta.col}` : "2px solid transparent",
                transition: "background 0.3s",
              }}>
                <span style={{ fontSize: 12, flexShrink: 0, marginTop: 1 }}>{meta.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 1 }}>
                    <span style={{
                      fontSize: 8, fontWeight: 800, letterSpacing: "0.08em",
                      color: meta.col, textTransform: "uppercase" as const,
                      background: `${meta.col}18`, padding: "1px 5px", borderRadius: 4,
                    }}>{meta.label}</span>
                    <span style={{ fontSize: 9, color: "#94a3b8" }}>{timeStr}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                    {summary}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </GlassCard>
  );
}

/* ══ HOME PAGE ═══════════════════════════════════════════════════════════ */
export default function HomePage() {
  const [health, setHealth]       = useState<ServiceHealth>({});
  const [stats, setStats]         = useState<Stats | null>(null);
  const [time, setTime]           = useState<Date | null>(null);
  const [events, setEvents]       = useState<FeedEvent[]>([]);
  const [wsConnected, setWsConn]  = useState(false);

  /* REST polling */
  const load = useCallback(async () => {
    fetch(`${GW}/health/services`).then(r => r.json()).then(setHealth).catch(() => {});
    try {
      const [eq, op] = await Promise.all([
        fetch(`${GW}/equity`).then(r => r.json()).catch(() => []),
        fetch(`${GW}/trades?limit=200&status=open`).then(r => r.json()).catch(() => []),
      ]);
      const equity: { cum_pnl: number; pnl: number; ts: string | null; trade_result: string }[] =
        Array.isArray(eq) ? eq : [];
      const opens: unknown[] = Array.isArray(op) ? op : [];
      const today = new Date().toDateString();
      const todayPts = equity.filter(p => p.ts && new Date(p.ts).toDateString() === today);
      const wins = equity.filter(p => p.trade_result === "WIN").length;
      setStats({
        total_pnl:   equity.length > 0 ? equity[equity.length - 1].cum_pnl : 0,
        today_pnl:   todayPts.reduce((s, p) => s + p.pnl, 0),
        win_rate:    equity.length > 0 ? Math.round(wins / equity.length * 100) : 0,
        open_trades: opens.length,
        equity_pts:  equity.length,
      });
    } catch { /* gateway offline */ }
  }, []);

  /* WebSocket feed */
  useEffect(() => {
    let ws: WebSocket;
    let retryTimer: ReturnType<typeof setTimeout>;

    function connect() {
      ws = new WebSocket(WS);
      ws.onopen  = () => setWsConn(true);
      ws.onclose = () => {
        setWsConn(false);
        retryTimer = setTimeout(connect, 4000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg: FeedEvent = JSON.parse(e.data);
          if (SKIP.has(msg.topic)) return;
          setEvents(prev => {
            const next = [...prev, msg];
            return next.length > 60 ? next.slice(-60) : next;
          });
        } catch { /* ignore */ }
      };
    }
    connect();
    return () => { ws?.close(); clearTimeout(retryTimer); };
  }, []);

  /* Clock */
  useEffect(() => {
    load();
    const t1 = setInterval(load, 30_000);
    setTime(new Date());
    const t2 = setInterval(() => setTime(new Date()), 1000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [load]);

  const fmt    = (v: number) => (v >= 0 ? "+" : "") + `$${Math.abs(v).toFixed(0)}`;
  const isHealthy = (k: string, v: string) =>
    v === "ok" || (k === "world_model" && REGIME_OK.has(v));
  const allOk  = Object.entries(health).every(([k, v]) => isHealthy(k, v));

  return (
    <div className="dot-bg" style={{ minHeight: "100vh", padding: "32px 36px 60px" }}>

      {/* ── Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 40 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12,
              background: "linear-gradient(135deg,#10b981,#6366f1)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 22, boxShadow: "0 4px 20px rgba(16,185,129,0.3)",
            }}>🏢</div>
            <div>
              <div style={{ fontSize: 28, fontWeight: 900, color: "#0f172a", letterSpacing: "-0.04em", lineHeight: 1 }}>POLIS</div>
              <div style={{ fontSize: 10, color: "#475569", letterSpacing: "0.18em", textTransform: "uppercase" as const }}>ระบบปฏิบัติการองค์กร AI</div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>
            {time?.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }) ?? ""}
          </div>
        </div>
        <div style={{ textAlign: "right" as const }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: "#1e293b", fontFamily: "var(--font-mono,monospace)", letterSpacing: "0.04em" }}>
            {time?.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) ?? "--:--:--"}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end", marginTop: 4 }}>
            <Dot col={allOk ? "#10b981" : "#f59e0b"} pulse={allOk} />
            <span style={{ fontSize: 10, color: allOk ? "#10b981" : "#f59e0b", fontWeight: 600 }}>
              {allOk ? "ระบบทำงานปกติ" : "บริการลดลง"}
            </span>
          </div>
        </div>
      </div>

      {/* ── KPI strip */}
      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 32 }}>
          <KpiPill icon="💰" label="P&L รวม"          value={stats.equity_pts === 0 ? "$0" : fmt(stats.total_pnl)}               col={stats.total_pnl >= 0 ? "#10b981" : "#ef4444"} />
          <KpiPill icon="🎯" label="อัตราชนะ"       value={stats.equity_pts > 0 ? `${stats.win_rate}%` : "—"}                  col={stats.win_rate >= 50 ? "#10b981" : "#ef4444"} />
          <KpiPill icon="📋" label="เทรดที่ปิด"      value={stats.equity_pts.toString()}                                        col="#818cf8" />
          <KpiPill icon="📊" label="โพซิชันเปิด"     value={stats.open_trades.toString()}                                       col="#22d3ee" />
        </div>
      )}

      {/* ── Departments */}
      <div style={{ fontSize: 9, color: "#94a3b8", letterSpacing: "0.14em", textTransform: "uppercase" as const, fontWeight: 700, marginBottom: 12 }}>
        แผนก
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 28 }}>
        <DeptCard
          icon="📊" name="เทรด" sub="เทรด forex + สินค้าโภคภัณฑ์ด้วย AI"
          color="#10b981" href="/trading" status="live"
          kpis={stats ? [
            { label: "P&L",        value: stats.equity_pts === 0 ? "$0" : fmt(stats.total_pnl), col: stats.total_pnl >= 0 ? "#10b981" : "#ef4444" },
            { label: "อัตราชนะ",   value: stats.equity_pts > 0 ? `${stats.win_rate}%` : "—",   col: stats.win_rate >= 50 ? "#10b981" : "#ef4444" },
            { label: "เปิดอยู่",   value: stats.open_trades.toString(),                          col: "#22d3ee" },
          ] : undefined}
        />
        <DeptCard
          icon="📱" name="โซเชียลมีเดีย" sub="สร้างคอนเทนต์ AI ข้ามแพลตฟอร์ม"
          color="#ec4899" href="/social" status="live"
          kpis={[
            { label: "แพลตฟอร์ม", value: "3",      col: "#ec4899" },
            { label: "AI engine",  value: "Gemini", col: "#22d3ee" },
            { label: "สถานะ",      value: "สด",     col: "#10b981" },
          ]}
        />
      </div>

      {/* ── โครงสร้างพื้นฐาน + Live Feed */}
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 14, marginBottom: 28 }}>
        <GlassCard style={{ padding: "20px 22px" }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#64748b", letterSpacing: "0.1em", textTransform: "uppercase" as const, marginBottom: 14 }}>
            โครงสร้างพื้นฐาน
          </div>
          <ServiceRow name="Gateway (API)"    status={health.gateway}         />
          <ServiceRow name="Redis (Pub/Sub)"  status={health.redis}           />
          <ServiceRow name="PostgreSQL (DB)"  status={health.postgres}        />
          <ServiceRow name="Kernel (AI)"      status={health.kernel}          />
          <ServiceRow name="Qdrant (Memory)"  status={health.qdrant}          />
          <ServiceRow name="World Model"      status={health.world_model}     svcKey="world_model" />
          <ServiceRow name="Circuit Breaker"  status={health.circuit_breaker} />
          <button type="button" onClick={load} style={{
            marginTop: 14, width: "100%", padding: "7px", borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.03)",
            color: "#475569", fontSize: 10, cursor: "pointer", fontWeight: 600,
          }}>↻ รีเฟรชสถานะ</button>
        </GlassCard>

        <LiveFeed events={events} wsConnected={wsConnected} />
      </div>

      {/* ── ไปที่หน้า */}
      <GlassCard style={{ padding: "20px 22px" }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: "#64748b", letterSpacing: "0.1em", textTransform: "uppercase" as const, marginBottom: 14 }}>
          นำทางด่วน
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 10 }}>
          {[
            { href: "/trading",              icon: "⚡", label: "ภาพรวม",        sub: "สัญญาณสด",           col: "#10b981" },
            { href: "/trading/board",        icon: "🏢", label: "ห้องประชุม",    sub: "การตัดสินใจผู้บริหาร", col: "#818cf8" },
            { href: "/trading/portfolio",    icon: "💼", label: "พอร์ตโฟลิโอ",  sub: "P&L + กราฟ",         col: "#22d3ee" },
            { href: "/finance",              icon: "💰", label: "การเงิน",       sub: "วิเคราะห์ & P&L",    col: "#f59e0b" },
            { href: "/social",               icon: "📱", label: "โซเชียลมีเดีย", sub: "สร้างคอนเทนต์ AI",   col: "#ec4899" },
            { href: "/trading/settings",     icon: "⚙️", label: "ตั้งค่า",       sub: "ความเสี่ยง + ตัวกรอง", col: "#64748b" },
          ].map(lk => (
            <Link key={lk.href} href={lk.href} style={{ textDecoration: "none" }}>
              <div style={{
                padding: "14px 16px", borderRadius: 12, cursor: "pointer",
                background: `${lk.col}09`, border: `1px solid ${lk.col}22`,
                transition: "background 0.15s",
              }}>
                <div style={{ fontSize: 18, marginBottom: 6 }}>{lk.icon}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#1e293b", marginBottom: 2 }}>{lk.label}</div>
                <div style={{ fontSize: 9, color: "#475569" }}>{lk.sub}</div>
              </div>
            </Link>
          ))}
        </div>
      </GlassCard>

      <div style={{ marginTop: 40, textAlign: "center" as const, fontSize: 9, color: "#1e293b", letterSpacing: "0.1em" }}>
        POLIS v0.1 · เบต้า · ระบบปฏิบัติการองค์กร AI
      </div>

    </div>
  );
}
