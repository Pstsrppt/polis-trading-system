"use client";
import { useCallback, useEffect, useState } from "react";

const GW = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";

type Subscriber = {
  id: number; telegram_id: number; username: string; plan: string;
  status: string; expires_at: string | null; paid_amount: number;
  notes: string | null; created_at: string;
};
type SubRequest = {
  id: number; username: string; telegram_id: number | null;
  plan: string; amount_thb: number; slip_note: string | null;
  status: string; created_at: string;
};
type Stats = {
  subscribers: { active: number; cancelled: number; mrr: number };
  performance:  { total_signals: number; wins: number; losses: number;
                  win_rate: number; total_pnl: number; avg_confidence: number };
  broadcasts_sent: number;
};

const PLAN_LABELS: Record<string, string> = {
  monthly: "รายเดือน", quarterly: "รายไตรมาส", annual: "รายปี",
};

function Card({ children, style, accent }: { children: React.ReactNode; style?: React.CSSProperties; accent?: string }) {
  return (
    <div style={{ background: "#ffffff", border: `1px solid ${accent ? accent + "30" : "rgba(0,0,0,0.07)"}`,
      borderRadius: 14, padding: "18px 20px", boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 4px 16px rgba(0,0,0,0.04)",
      ...style }}>{children}</div>
  );
}

function KpiCard({ icon, label, value, sub, color }: { icon: string; label: string; value: string; sub?: string; color: string }) {
  return (
    <div style={{ background: `linear-gradient(135deg,${color}12,${color}06)`,
      border: `1px solid ${color}28`, borderRadius: 14, padding: "16px 20px" }}>
      <div style={{ fontSize: 9, color: `${color}99`, textTransform: "uppercase" as const,
        letterSpacing: "0.1em", fontWeight: 700, marginBottom: 4 }}>{icon} {label}</div>
      <div style={{ fontSize: 28, fontWeight: 900, color, fontFamily: "var(--font-mono,monospace)", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "#64748b", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

export default function SignalsPage() {
  const [stats, setStats]         = useState<Stats | null>(null);
  const [subs,  setSubs]          = useState<Subscriber[]>([]);
  const [requests, setRequests]   = useState<SubRequest[]>([]);
  const [loading, setLoading]     = useState(true);
  const [form, setForm]           = useState({ telegram_id: "", username: "", days: "30", paid_amount: "500" });
  const [adding, setAdding]       = useState(false);
  const [msg, setMsg]             = useState("");
  const [actionId, setActionId]   = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [sr, subr, reqs] = await Promise.all([
        fetch(`${GW}/signals/stats`).then(r => r.json()),
        fetch(`${GW}/signals/subscribers`).then(r => r.json()),
        fetch(`${GW}/signals/subscribe-requests?status=pending`).then(r => r.json()),
      ]);
      setStats(sr);
      setSubs(Array.isArray(subr) ? subr : []);
      setRequests(Array.isArray(reqs) ? reqs : []);
    } catch { /* offline */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);

  const approveRequest = async (id: number) => {
    setActionId(id);
    try {
      const r = await fetch(`${GW}/signals/subscribe-request/${id}/approve`, { method: "POST" });
      if (r.ok) load();
    } finally { setActionId(null); }
  };

  const rejectRequest = async (id: number) => {
    if (!confirm("ปฏิเสธคำขอนี้?")) return;
    setActionId(id);
    try {
      const r = await fetch(`${GW}/signals/subscribe-request/${id}/reject`, { method: "POST" });
      if (r.ok) load();
    } finally { setActionId(null); }
  };

  const addSub = async () => {
    if (!form.telegram_id || !form.username) return;
    setAdding(true); setMsg("");
    try {
      const r = await fetch(`${GW}/signals/subscribers`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          telegram_id: parseInt(form.telegram_id),
          username: form.username.replace("@", ""),
          days: parseInt(form.days),
          paid_amount: parseFloat(form.paid_amount),
          plan: "monthly",
        }),
      });
      if (r.ok) { setMsg("✅ เพิ่มแล้ว!"); setForm({ telegram_id: "", username: "", days: "30", paid_amount: "500" }); load(); }
      else setMsg("❌ " + (await r.json()).detail);
    } catch (e) { setMsg("❌ " + String(e)); }
    finally { setAdding(false); }
  };

  const cancelSub = async (tgId: number) => {
    if (!confirm("ยกเลิก subscriber นี้?")) return;
    await fetch(`${GW}/signals/subscribers/${tgId}`, { method: "DELETE" });
    load();
  };

  const active    = subs.filter(s => s.status === "active");
  const cancelled = subs.filter(s => s.status !== "active");
  const perf      = stats?.performance;
  const winRate   = perf ? perf.win_rate : 0;
  const mrr       = stats?.subscribers.mrr ?? 0;

  return (
    <div className="dot-bg" style={{ minHeight: "100vh", padding: "24px 28px 60px" }}>

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.12em", textTransform: "uppercase" as const, marginBottom: 6 }}>
          POLIS HQ › Signal Service
        </div>
        <div style={{ fontSize: 26, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.03em", lineHeight: 1 }}>
          💎 Signal Service
        </div>
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
          บริการส่ง trading signals ให้ผู้ติดตาม · สร้างรายได้ recurring
        </div>
      </div>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 24 }}>
        <KpiCard icon="👥" label="Active Subscribers" value={String(stats?.subscribers.active ?? 0)} color="#10b981" sub="คนที่จ่ายอยู่" />
        <KpiCard icon="💰" label="MRR" value={`$${mrr.toFixed(0)}`} color="#f59e0b" sub="รายได้ต่อเดือน" />
        <KpiCard icon="📡" label="Signals Sent" value={String(stats?.broadcasts_sent ?? 0)} color="#818cf8" sub="สัญญาณทั้งหมด" />
        <KpiCard icon="🎯" label="Win Rate" value={`${winRate}%`}
          color={winRate >= 55 ? "#10b981" : winRate >= 45 ? "#f59e0b" : "#ef4444"}
          sub={`${perf?.wins ?? 0}W · ${perf?.losses ?? 0}L`} />
      </div>

      {/* Pending Requests — shown only when there are pending items */}
      {requests.length > 0 && (
        <div style={{ marginBottom: 20, padding: "16px 20px", borderRadius: 16,
          background: "linear-gradient(135deg,#fefce8,#fffbeb)",
          border: "1.5px solid rgba(245,158,11,0.35)",
          boxShadow: "0 2px 12px rgba(245,158,11,0.10)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <div style={{ fontSize: 18 }}>⏳</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#92400e" }}>
                คำขอสมัครรอการอนุมัติ ({requests.length})
              </div>
              <div style={{ fontSize: 10, color: "#b45309" }}>ตรวจสอบสลิปแล้วกดอนุมัติหรือปฏิเสธครับ</div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 10 }}>
            {requests.map(req => {
              const busy = actionId === req.id;
              const planLabel = PLAN_LABELS[req.plan] ?? req.plan;
              return (
                <div key={req.id} style={{ display: "flex", alignItems: "center", gap: 14,
                  background: "#fff", borderRadius: 10, padding: "12px 16px",
                  border: "1px solid rgba(245,158,11,0.2)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
                      @{req.username}
                      {req.telegram_id ? (
                        <span style={{ marginLeft: 8, fontSize: 9, color: "#94a3b8", fontFamily: "var(--font-mono,monospace)" }}>
                          ID: {req.telegram_id}
                        </span>
                      ) : (
                        <span style={{ marginLeft: 8, fontSize: 9, color: "#f59e0b" }}>ไม่มี Telegram ID</span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>
                      แผน: <b>{planLabel}</b> · ฿{req.amount_thb?.toLocaleString()}
                      {req.slip_note && <span> · 📝 {req.slip_note}</span>}
                      <span style={{ marginLeft: 6, color: "#94a3b8" }}>
                        #{req.id} · {new Date(req.created_at).toLocaleString("th-TH", {
                          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
                        })}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button type="button" disabled={busy} onClick={() => approveRequest(req.id)} style={{
                      padding: "6px 14px", borderRadius: 8, fontSize: 11, fontWeight: 700,
                      cursor: busy ? "not-allowed" : "pointer",
                      background: busy ? "#e2e8f0" : "linear-gradient(135deg,#10b981,#059669)",
                      color: busy ? "#94a3b8" : "#fff", border: "none",
                    }}>
                      {busy ? "…" : "✅ อนุมัติ"}
                    </button>
                    <button type="button" disabled={busy} onClick={() => rejectRequest(req.id)} style={{
                      padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 700,
                      cursor: busy ? "not-allowed" : "pointer",
                      background: "rgba(239,68,68,0.08)", color: "#ef4444",
                      border: "1px solid rgba(239,68,68,0.25)",
                    }}>
                      ❌
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 20, alignItems: "start" }}>

        {/* Subscriber List */}
        <div>
          {/* Active */}
          <Card style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#10b981", marginBottom: 14 }}>
              ✅ Active Subscribers ({active.length})
            </div>
            {active.length === 0 ? (
              <div style={{ color: "#94a3b8", fontSize: 11, fontStyle: "italic" }}>ยังไม่มี subscriber — เพิ่มด้านขวาเลยครับ</div>
            ) : active.map(s => (
              <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "10px 0", borderBottom: "1px solid rgba(0,0,0,0.05)" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>@{s.username}</div>
                  <div style={{ fontSize: 10, color: "#64748b" }}>
                    ID: {s.telegram_id} · หมดอายุ: {s.expires_at ? new Date(s.expires_at).toLocaleDateString("th-TH") : "ไม่มีกำหนด"}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#10b981" }}>${s.paid_amount}/เดือน</span>
                  <button type="button" onClick={() => cancelSub(s.telegram_id)} style={{
                    fontSize: 9, padding: "3px 8px", borderRadius: 5, cursor: "pointer",
                    border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.06)", color: "#ef4444",
                  }}>ยกเลิก</button>
                </div>
              </div>
            ))}
          </Card>

          {/* Cancelled */}
          {cancelled.length > 0 && (
            <Card>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", marginBottom: 12 }}>
                ❌ Cancelled ({cancelled.length})
              </div>
              {cancelled.slice(0, 5).map(s => (
                <div key={s.id} style={{ display: "flex", justifyContent: "space-between",
                  padding: "6px 0", borderBottom: "1px solid rgba(0,0,0,0.04)", opacity: 0.6 }}>
                  <span style={{ fontSize: 11, color: "#64748b" }}>@{s.username} ({s.telegram_id})</span>
                  <span style={{ fontSize: 9, color: "#94a3b8" }}>ยกเลิกแล้ว</span>
                </div>
              ))}
            </Card>
          )}
        </div>

        {/* Right Panel */}
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 14 }}>

          {/* Add Subscriber */}
          <Card accent="#10b981">
            <div style={{ fontSize: 11, fontWeight: 700, color: "#10b981", marginBottom: 14 }}>➕ เพิ่ม Subscriber ใหม่</div>
            {[
              { label: "Telegram ID", key: "telegram_id", placeholder: "123456789" },
              { label: "Username", key: "username", placeholder: "@username" },
              { label: "จำนวนวัน", key: "days", placeholder: "30" },
              { label: "ราคา (USD/เดือน)", key: "paid_amount", placeholder: "20" },
            ].map(f => (
              <div key={f.key} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 9, color: "#64748b", textTransform: "uppercase" as const,
                  letterSpacing: "0.08em", marginBottom: 4 }}>{f.label}</div>
                <input
                  type={f.key === "telegram_id" || f.key === "days" || f.key === "paid_amount" ? "number" : "text"}
                  value={form[f.key as keyof typeof form]}
                  onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  title={f.label}
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 7,
                    border: "1px solid rgba(0,0,0,0.1)", background: "#f8fafc",
                    color: "#0f172a", fontSize: 11, fontFamily: "var(--font-mono,monospace)" }}
                />
              </div>
            ))}
            {msg && <div style={{ fontSize: 10, marginBottom: 8, color: msg.startsWith("✅") ? "#10b981" : "#ef4444" }}>{msg}</div>}
            <button type="button" onClick={addSub} disabled={adding} style={{
              width: "100%", padding: "8px", borderRadius: 8, fontSize: 11, fontWeight: 700,
              cursor: "pointer", border: "1px solid rgba(16,185,129,0.4)",
              background: "rgba(16,185,129,0.12)", color: adding ? "#94a3b8" : "#10b981",
            }}>{adding ? "กำลังเพิ่ม…" : "✅ เพิ่ม Subscriber"}</button>
          </Card>

          {/* Signal Format Preview */}
          <Card accent="#818cf8">
            <div style={{ fontSize: 11, fontWeight: 700, color: "#818cf8", marginBottom: 12 }}>📡 ตัวอย่าง Signal ที่ subscriber จะได้รับ</div>
            <div style={{ background: "#0f172a", borderRadius: 8, padding: "12px 14px",
              fontFamily: "var(--font-mono,monospace)", fontSize: 11, lineHeight: 1.8, color: "#e2e8f0" }}>
              <div>🚨 <b>POLIS SIGNAL ALERT</b> 🚨</div>
              <div>&nbsp;</div>
              <div>📈 <b>LONG XAU/USD</b></div>
              <div>&nbsp;</div>
              <div>💰 Entry:       <b>$2,341</b></div>
              <div>🎯 Take Profit: <b>$2,360</b></div>
              <div>🛑 Stop Loss:   <b>$2,332</b></div>
              <div>&nbsp;</div>
              <div>📊 Confidence:  <b>82%</b></div>
              <div>⚡ Risk/Reward: <b>1:2.0</b></div>
              <div>⚠️ Risk/Trade:  <b>$58.50</b></div>
              <div>&nbsp;</div>
              <div>🤖 <i>POLIS AI Trading OS</i></div>
            </div>
          </Card>

          {/* Setup guide */}
          <Card>
            <div style={{ fontSize: 9, fontWeight: 700, color: "#475569", textTransform: "uppercase" as const,
              letterSpacing: "0.1em", marginBottom: 10 }}>วิธีตั้งค่า Channel</div>
            <div style={{ fontSize: 10, color: "#64748b", lineHeight: 1.9 }}>
              <div>1️⃣ สร้าง Telegram Channel (private)</div>
              <div>2️⃣ เพิ่ม Bot เป็น Admin ของ channel</div>
              <div>3️⃣ Copy Channel ID (เช่น -1001234567890)</div>
              <div>4️⃣ ใส่ใน <code style={{ color: "#818cf8" }}>.env</code>:</div>
              <div style={{ marginLeft: 16 }}><code style={{ color: "#22d3ee", fontSize: 9 }}>SIGNAL_CHANNEL_ID=-1001234567890</code></div>
              <div>5️⃣ Restart kernel</div>
              <div style={{ marginTop: 8, padding: "8px 10px", background: "#f0fdf4",
                borderRadius: 7, border: "1px solid rgba(16,185,129,0.2)", fontSize: 9, color: "#15803d" }}>
                ทุกครั้งที่ POLIS อนุมัติ trade → signal ส่งไปทันที
              </div>
            </div>
          </Card>

        </div>
      </div>
    </div>
  );
}
