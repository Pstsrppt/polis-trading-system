"use client";
import { useEffect, useRef, useState } from "react";

const GW   = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";
const GWWS = process.env.NEXT_PUBLIC_GATEWAY_WS  ?? "ws://localhost:19000/ws/feed";

type Ev = { topic: string; data: Record<string, unknown>; ts: string };
type NotifyStatus = {
  telegram: { configured: boolean; has_token: boolean; has_chat_id: boolean };
  discord:  { configured: boolean };
};
type TestResult = Record<string, string>;

const NOTIFY_TOPICS = new Set([
  "TRADE_APPROVED","POLICY_BLOCKED","SIGNAL_REJECTED",
  "BOARD_RESOLUTION","TRADE_CLOSED","AGENT_HIRED","AGENT_FIRED",
  "CIRCUIT_BREAKER_TRIGGERED","CIRCUIT_BREAKER_RESET",
]);

function Chip({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 6,
      background: color + "18", color, border: `1px solid ${color}30`,
      letterSpacing: "0.06em", textTransform: "uppercase" as const,
      whiteSpace: "nowrap" as const, lineHeight: 1.4,
    }}>{label}</span>
  );
}

function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <div style={{
      width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
      background: color, boxShadow: `0 0 8px ${color}`,
      animation: pulse ? "pulse 2s ease-in-out infinite" : undefined,
    }} />
  );
}

function Card({ children, style, accent }: { children: React.ReactNode; style?: React.CSSProperties; accent?: string }) {
  return (
    <div style={{
      background: "#ffffff",
      border: `1px solid ${accent ? accent + "22" : "rgba(0,0,0,0.07)"}`,
      borderRadius: 16, padding: "20px 22px",
      boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 4px 16px rgba(0,0,0,0.04)",
      ...style,
    }}>{children}</div>
  );
}

function SectionLabel({ icon, label, accent = "#6366f1", right }: { icon: string; label: string; accent?: string; right?: React.ReactNode }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      margin: "28px 0 14px", padding: "10px 16px", borderRadius: 10,
      background: `linear-gradient(90deg,${accent}14,transparent)`,
      borderLeft: `3px solid ${accent}`,
    }}>
      <span style={{ fontSize: 15 }}>{icon}</span>
      <span style={{ fontSize: 10, fontWeight: 800, color: "#1e293b", letterSpacing: "0.12em", textTransform: "uppercase" as const, flex: 1 }}>{label}</span>
      {right}
    </div>
  );
}

/* ── Channel Card ────────────────────────────────────────────────────── */
function ChannelCard({
  icon, name, desc, configured, testResult, onTest, testing,
}: {
  icon: string; name: string; desc: string;
  configured: boolean; testResult: string | null;
  onTest: () => void; testing: boolean;
}) {
  const col = configured ? "#10b981" : "#475569";
  const resultCol = testResult === "ok" ? "#10b981"
    : testResult === null ? "#334155"
    : "#ef4444";

  return (
    <Card accent={col}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 48, height: 48, borderRadius: 14, flexShrink: 0,
            background: `${col}18`, border: `1.5px solid ${col}30`,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22,
          }}>{icon}</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#0f172a", marginBottom: 3 }}>{name}</div>
            <div style={{ fontSize: 10, color: "#64748b" }}>{desc}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <Dot color={col} pulse={configured} />
          <span style={{ fontSize: 10, fontWeight: 700, color: col }}>
            {configured ? "Connected" : "ยังไม่ตั้งค่า"}
          </span>
        </div>
      </div>

      {!configured && (
        <div style={{
          padding: "10px 14px", borderRadius: 10, marginBottom: 14,
          background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.18)",
        }}>
          <div style={{ fontSize: 10, color: "#64748b", lineHeight: 1.7 }}>
            ตั้งค่าใน <code style={{ color: "#22d3ee", fontFamily: "var(--font-mono,monospace)", fontSize: 10 }}>.env</code> แล้ว restart kernel:
            <br />
            {name === "Telegram"
              ? <><code style={{ color: "#fbbf24", fontSize: 9 }}>TELEGRAM_BOT_TOKEN=...</code><br /><code style={{ color: "#fbbf24", fontSize: 9 }}>TELEGRAM_CHAT_ID=...</code></>
              : <code style={{ color: "#fbbf24", fontSize: 9 }}>DISCORD_WEBHOOK_URL=...</code>}
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          type="button"
          onClick={onTest}
          disabled={!configured || testing}
          style={{
            flex: 1, padding: "10px", borderRadius: 10, cursor: configured ? "pointer" : "default",
            fontWeight: 700, fontSize: 12, letterSpacing: "0.04em",
            background: configured ? `${col}18` : "rgba(0,0,0,0.03)",
            color: configured ? col : "#334155",
            border: `1px solid ${configured ? col + "30" : "rgba(0,0,0,0.05)"}`,
            transition: "all 0.2s",
          }}
        >
          {testing ? "Sending…" : "📤 ส่งทดสอบ Message"}
        </button>
        {testResult !== null && (
          <div style={{
            padding: "8px 14px", borderRadius: 9, fontSize: 11, fontWeight: 700,
            background: `${resultCol}12`, border: `1px solid ${resultCol}25`, color: resultCol,
          }}>
            {testResult === "ok" ? "✅ Sent" : `❌ ${testResult}`}
          </div>
        )}
      </div>
    </Card>
  );
}

/* ── Notification Row ────────────────────────────────────────────────── */
const EV_COLOR: Record<string, string> = {
  TRADE_APPROVED: "#10b981", POLICY_BLOCKED: "#f59e0b", BOARD_RESOLUTION: "#ec4899",
  TRADE_CLOSED: "#22d3ee", AGENT_HIRED: "#6366f1", AGENT_FIRED: "#ef4444",
};
const EV_ICON: Record<string, string> = {
  TRADE_APPROVED: "✅", POLICY_BLOCKED: "⚠️", BOARD_RESOLUTION: "🏛",
  TRADE_CLOSED: "💰", AGENT_HIRED: "🟢", AGENT_FIRED: "🔴",
};
const EV_CHAN: Record<string, string[]> = {
  TRADE_APPROVED: ["Telegram", "Discord"], BOARD_RESOLUTION: ["Telegram"],
  TRADE_CLOSED:   ["Telegram", "Discord"], POLICY_BLOCKED: [],
  AGENT_HIRED: [], AGENT_FIRED: [],
};

const fmtPrice = (v:number) => v < 10 ? v.toFixed(5) : v < 1000 ? v.toFixed(2) : v.toFixed(0);

function evSummary(ev: Ev): string {
  const d = ev.data;
  switch (ev.topic) {
    case "TRADE_APPROVED":            return `${String(d.direction ?? "").toUpperCase()} ${d.symbol} @ $${fmtPrice(Number(d.price ?? 0))} · ${d.lots} lots`;
    case "POLICY_BLOCKED":            return `${String(d.direction ?? "").toUpperCase()} ${d.symbol} — ${d.reason ?? "blocked"}`;
    case "SIGNAL_REJECTED":           return `${d.symbol} — ${(d.rejected_reasons as string[]|undefined)?.[0] ?? "rejected"}`;
    case "BOARD_RESOLUTION":          return `${String(d.resolution ?? "").toUpperCase()} · ${d.directive}`;
    case "TRADE_CLOSED":              return `${String(d.direction ?? "").toUpperCase()} ${d.symbol} · P&L $${Number(d.pnl_usd ?? 0).toFixed(2)}`;
    case "AGENT_HIRED":               return `${d.role} joined ${d.division}`;
    case "AGENT_FIRED":               return `${d.role} removed`;
    case "CIRCUIT_BREAKER_TRIGGERED": return `หยุดรับสัญญาณ — ${d.reason ?? "triggered"}`;
    case "CIRCUIT_BREAKER_RESET":     return "Circuit Breaker รีเซ็ตแล้ว — ระบบกลับมาปกติ";
    default: return JSON.stringify(d).slice(0, 80);
  }
}

/* ══ NOTIFICATIONS PAGE ══════════════════════════════════════════════════ */
export default function NotificationsPage() {
  const [status,     setStatus]     = useState<NotifyStatus | null>(null);
  const [testResult, setTestResult] = useState<TestResult>({});
  const [testing,    setTesting]    = useState(false);
  const [events,     setEvents]     = useState<Ev[]>([]);
  const [connected,  setConnected]  = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    fetch(`${GW}/notify/status`)
      .then(r => r.json()).then((d: NotifyStatus) => setStatus(d)).catch(() => {});

    fetch(`${GW}/events`)
      .then(r => r.json())
      .then((d: Ev[]) => setEvents(d.filter(e => NOTIFY_TOPICS.has(e.topic))))
      .catch(() => {});

    function connect() {
      const ws = new WebSocket(GWWS); wsRef.current = ws;
      ws.onopen  = () => setConnected(true);
      ws.onclose = () => { setConnected(false); setTimeout(connect, 3000); };
      ws.onerror = () => ws.close();
      ws.onmessage = ({ data }) => {
        const ev: Ev = JSON.parse(data);
        if (NOTIFY_TOPICS.has(ev.topic)) {
          setEvents(p => [ev, ...p].slice(0, 200));
        }
      };
    }
    connect();
    return () => { wsRef.current?.close(); };
  }, []);

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await fetch(`${GW}/notify/test`, { method: "POST" });
      const d: TestResult = await r.json();
      setTestResult(d);
    } catch {
      setTestResult({ error: "Gateway unreachable" });
    } finally {
      setTesting(false);
    }
  };

  const tg = status?.telegram;
  const dc = status?.discord;
  const notifyEvents = events.filter(e => NOTIFY_TOPICS.has(e.topic));

  return (
    <div className="dot-bg" style={{ minHeight: "100vh", background: "var(--bg)", padding: "24px 28px 48px" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.12em", textTransform: "uppercase" as const, marginBottom: 6 }}>
            POLIS HQ › เทรด › การแจ้งเตือน
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em", color: "#0f172a", lineHeight: 1 }}>
            Notification Center
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
            Telegram · Discord · Alert history
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 6, padding: "5px 12px",
            borderRadius: 8, background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.06)",
          }}>
            <Dot color={connected ? "#10b981" : "#ef4444"} pulse={connected} />
            <span style={{ fontSize: 10, color: connected ? "#34d399" : "#f87171", fontWeight: 600 }}>
              {connected ? "Live" : "Reconnecting…"}
            </span>
          </div>
        </div>
      </div>

      {/* Status summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 0 }}>
        {[
          {
            label: "Telegram",
            value: tg ? (tg.configured ? "Online" : "Not set") : "…",
            color: tg?.configured ? "#10b981" : "#475569",
            icon: "📱",
          },
          {
            label: "Discord",
            value: dc ? (dc.configured ? "Online" : "Not set") : "…",
            color: dc?.configured ? "#818cf8" : "#475569",
            icon: "🎮",
          },
          {
            label: "Alerts Sent",
            value: notifyEvents.filter(e => e.topic === "TRADE_APPROVED" || e.topic === "TRADE_CLOSED").length.toString(),
            color: "#22d3ee",
            icon: "📤",
          },
        ].map(k => (
          <div key={k.label} style={{
            display: "flex", alignItems: "center", gap: 14,
            padding: "16px 20px", borderRadius: 14,
            background: `linear-gradient(135deg,${k.color}12,${k.color}04,transparent)`,
            border: `1px solid ${k.color}22`,
          }}>
            <span style={{ fontSize: 22 }}>{k.icon}</span>
            <div>
              <div style={{ fontSize: 9, color: k.color + "99", textTransform: "uppercase" as const, letterSpacing: "0.1em", fontWeight: 700, marginBottom: 3 }}>{k.label}</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: k.color, fontFamily: "var(--font-mono,monospace)", lineHeight: 1 }}>{k.value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Channel cards */}
      <SectionLabel icon="📡" label="Channels" accent="#6366f1" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 0 }}>
        <ChannelCard
          icon="📱" name="Telegram" desc="Real-time trade alerts in Thai + English"
          configured={tg?.configured ?? false}
          testResult={testResult.telegram ?? null}
          testing={testing}
          onTest={sendTest}
        />
        <ChannelCard
          icon="🎮" name="Discord" desc="Rich embed notifications with P&L details"
          configured={dc?.configured ?? false}
          testResult={testResult.discord ?? null}
          testing={testing}
          onTest={sendTest}
        />
      </div>

      {/* What gets sent */}
      <SectionLabel icon="📋" label="กฎการแจ้งเตือน" accent="#f59e0b" />
      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
          {[
            { topic: "TRADE_APPROVED", channels: ["Telegram", "Discord"], desc: "Trade approved + lots + notional" },
            { topic: "TRADE_CLOSED",   channels: ["Telegram", "Discord"], desc: "P&L + entry/exit + result" },
            { topic: "BOARD_RESOLUTION",          channels: ["Telegram","Discord"], desc: "Board decision + directive" },
            { topic: "POLICY_BLOCKED",            channels: ["Telegram"], desc: "LLM/policy blocked signal" },
            { topic: "SIGNAL_REJECTED",           channels: ["Telegram"], desc: "Filter rejected (conf/ATR/hours/correlation)" },
            { topic: "CIRCUIT_BREAKER_TRIGGERED", channels: ["Telegram","Discord"], desc: "Emergency halt — use /resume to reset" },
            { topic: "DAILY_BRIEFING",            channels: ["Telegram","Discord"], desc: "Morning summary (08:00 Bangkok)" },
          ].map(rule => {
            const col = EV_COLOR[rule.topic] ?? "#475569";
            const hasChannels = rule.channels.length > 0;
            return (
              <div key={rule.topic} style={{
                padding: "12px 14px", borderRadius: 10,
                background: hasChannels ? `${col}08` : "#f8fafc",
                border: `1px solid ${hasChannels ? col + "22" : "rgba(0,0,0,0.04)"}`,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <span style={{ fontSize: 12 }}>{EV_ICON[rule.topic] ?? "•"}</span>
                  <span style={{ fontSize: 9, fontWeight: 800, color: col, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>
                    {rule.topic.replace(/_/g, " ")}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: "#64748b", marginBottom: 8, lineHeight: 1.5 }}>{rule.desc}</div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" as const }}>
                  {rule.channels.length === 0
                    ? <Chip label="Silent" color="#334155" />
                    : rule.channels.map(ch => <Chip key={ch} label={ch} color={ch === "Telegram" ? "#22d3ee" : "#818cf8"} />)}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Alert history */}
      <SectionLabel icon="🕐" label="Alert History" accent="#10b981"
        right={<span style={{ fontSize: 9, color: "#334155" }}>{notifyEvents.length} events</span>} />
      <Card>
        {notifyEvents.length === 0 ? (
          <div style={{ textAlign: "center" as const, color: "#475569", padding: "36px 0", fontSize: 12, fontStyle: "italic" }}>
            Waiting for trade events…
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 480, overflowY: "auto" }}>
            {notifyEvents.map((ev, i) => {
              const col = EV_COLOR[ev.topic] ?? "#475569";
              const icon = EV_ICON[ev.topic] ?? "•";
              const channels = EV_CHAN[ev.topic] ?? [];
              return (
                <div key={i} style={{
                  display: "flex", alignItems: "flex-start", gap: 12,
                  padding: "10px 12px", borderRadius: 9,
                  background: "#f8fafc",
                  borderLeft: `3px solid ${col}55`,
                }}>
                  <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>{icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                      <Chip label={ev.topic.replace(/_/g, " ")} color={col} />
                      {channels.map(ch => (
                        <Chip key={ch} label={ch} color={ch === "Telegram" ? "#22d3ee" : "#818cf8"} />
                      ))}
                      <span style={{ marginLeft: "auto", fontSize: 9, color: "#475569", fontFamily: "var(--font-mono,monospace)", flexShrink: 0 }}>
                        {new Date(ev.ts).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", day: "numeric", month: "short" })}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.5 }}>{evSummary(ev)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
