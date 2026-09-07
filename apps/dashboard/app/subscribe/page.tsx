"use client";
import { useEffect, useRef, useState } from "react";

const GW = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";

type Plan = { label: string; days: number; thb: number; save: string };
type Plans = Record<string, Plan>;

const PLAN_COLORS: Record<string, string> = {
  monthly:   "#10b981",
  quarterly: "#818cf8",
  annual:    "#f59e0b",
};
const PLAN_ICONS: Record<string, string> = {
  monthly:   "📅",
  quarterly: "🗓️",
  annual:    "🏆",
};

/* ── Waiting / Approved screen ─────────────────────────────────────── */
function PendingScreen({ reqId, plan }: { reqId: number; plan: string }) {
  const [status, setStatus]       = useState<"pending" | "approved" | "rejected">("pending");
  const [inviteLink, setInviteLink] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const poll = async () => {
      try {
        const r = await fetch(`${GW}/signals/subscribe-request/status/${reqId}`);
        if (!r.ok) return;
        const d = await r.json();
        if (d.status === "approved") {
          setInviteLink(d.invite_link ?? "");
          setStatus("approved");
          if (timerRef.current) clearInterval(timerRef.current);
        } else if (d.status === "rejected") {
          setStatus("rejected");
          if (timerRef.current) clearInterval(timerRef.current);
        }
      } catch { /* ignore */ }
    };
    poll();
    timerRef.current = setInterval(poll, 8000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [reqId]);

  if (status === "approved") return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center",
      justifyContent: "center", background: "linear-gradient(135deg,#f0fdf4,#ecfdf5)", padding: 24 }}>
      <div style={{ textAlign: "center", maxWidth: 440 }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>🎉</div>
        <div style={{ fontSize: 24, fontWeight: 900, color: "#0f172a", marginBottom: 8 }}>
          อนุมัติแล้วครับ!
        </div>
        <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.8, marginBottom: 28 }}>
          ขอบคุณที่สมัครแผน <strong>{plan}</strong> ครับ<br />
          คลิก link ด้านล่างเพื่อเข้าร่วม Telegram channel รับ signal ได้เลย
        </div>
        {inviteLink ? (
          <a href={inviteLink} target="_blank" rel="noopener noreferrer" style={{
            display: "inline-block", padding: "14px 28px", borderRadius: 12,
            background: "linear-gradient(135deg,#10b981,#059669)",
            color: "#fff", fontWeight: 800, fontSize: 15, textDecoration: "none",
            boxShadow: "0 4px 20px rgba(16,185,129,0.35)",
          }}>
            📡 เข้าร่วม POLIS Signal Channel
          </a>
        ) : (
          <div style={{ fontSize: 12, color: "#94a3b8" }}>
            Admin จะส่ง link ให้ทาง Telegram ครับ
          </div>
        )}
        <div style={{ marginTop: 24, fontSize: 10, color: "#94a3b8" }}>🤖 POLIS AI Trading OS</div>
      </div>
    </div>
  );

  if (status === "rejected") return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center",
      justifyContent: "center", background: "#fff8f8", padding: 24 }}>
      <div style={{ textAlign: "center", maxWidth: 400 }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>❌</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#0f172a", marginBottom: 8 }}>คำขอถูกปฏิเสธ</div>
        <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.7, marginBottom: 20 }}>
          กรุณาติดต่อ admin เพื่อสอบถามเพิ่มเติมครับ
        </div>
        <button type="button" onClick={() => window.location.reload()} style={{
          padding: "10px 24px", borderRadius: 9, fontSize: 13, fontWeight: 700,
          background: "#f1f5f9", border: "1px solid rgba(0,0,0,0.1)", cursor: "pointer", color: "#475569",
        }}>ลองใหม่อีกครั้ง</button>
      </div>
    </div>
  );

  // pending
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center",
      justifyContent: "center", background: "linear-gradient(135deg,#f8fafc,#f0f4f8)", padding: 24 }}>
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <div style={{ fontSize: 56, marginBottom: 16 }}>⏳</div>
        <div style={{ fontSize: 22, fontWeight: 900, color: "#0f172a", marginBottom: 8 }}>
          รอ Admin ตรวจสอบ
        </div>
        <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.8, marginBottom: 28 }}>
          ส่งคำขอแล้วครับ (#{ reqId})<br />
          Admin กำลังตรวจสอบการชำระเงิน<br />
          หน้านี้จะอัปเดตอัตโนมัติทุก 8 วินาที
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: 6 }}>
          {[0,1,2].map(i => (
            <div key={i} style={{
              width: 8, height: 8, borderRadius: "50%", background: "#10b981",
              animation: `pulse 1.4s ease-in-out ${i * 0.3}s infinite`,
            }} />
          ))}
        </div>
        <style>{`@keyframes pulse { 0%,100%{opacity:.3;transform:scale(.8)} 50%{opacity:1;transform:scale(1)} }`}</style>
        <div style={{ marginTop: 28, padding: "12px 16px", background: "#f0fdf4",
          borderRadius: 10, border: "1px solid rgba(16,185,129,0.2)", fontSize: 11, color: "#15803d" }}>
          📱 เมื่ออนุมัติแล้ว — invite link จะปรากฏที่หน้านี้ทันทีครับ
        </div>
      </div>
    </div>
  );
}

/* ── Main Page ─────────────────────────────────────────────────────── */
export default function SubscribePage() {
  const [plans, setPlans]         = useState<Plans>({});
  const [selected, setSelected]   = useState("monthly");
  const [qr, setQr]               = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [form, setForm]           = useState({ username: "", telegram_id: "", slip_note: "" });
  const [submitting, setSubmitting] = useState(false);
  const [reqId, setReqId]         = useState<number | null>(null);
  const [error, setError]         = useState("");

  useEffect(() => {
    fetch(`${GW}/signals/plans`).then(r => r.json()).then(setPlans).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selected) return;
    setQr(null); setQrLoading(true);
    fetch(`${GW}/signals/qr/${selected}`)
      .then(r => r.json())
      .then(d => { setQr(d.qr_b64 ?? null); })
      .catch(() => setQr(null))
      .finally(() => setQrLoading(false));
  }, [selected]);

  const submit = async () => {
    if (!form.username) { setError("กรุณาใส่ Telegram username ครับ"); return; }
    setSubmitting(true); setError("");
    try {
      const plan = plans[selected];
      const r = await fetch(`${GW}/signals/subscribe-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username:    form.username.replace("@", ""),
          telegram_id: form.telegram_id ? parseInt(form.telegram_id) : null,
          plan:        selected,
          amount_thb:  plan?.thb ?? 0,
          slip_note:   form.slip_note,
        }),
      });
      if (r.ok) {
        const d = await r.json();
        setReqId(d.id ?? 1);
      } else {
        const d = await r.json();
        setError(d.detail ?? "เกิดข้อผิดพลาด");
      }
    } catch { setError("ไม่สามารถเชื่อมต่อได้"); }
    finally { setSubmitting(false); }
  };

  // After submit — show polling screen
  if (reqId !== null) {
    const planLabel = plans[selected]?.label ?? selected;
    return <PendingScreen reqId={reqId} plan={planLabel} />;
  }

  const plan  = plans[selected];
  const color = PLAN_COLORS[selected] ?? "#10b981";

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg,#f8fafc 0%,#f0f4f8 100%)",
      padding: "32px 16px 80px", fontFamily: "var(--font-sans, sans-serif)" }}>

      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 36 }}>
        <div style={{ fontSize: 11, color: "#64748b", letterSpacing: "0.15em",
          textTransform: "uppercase", marginBottom: 8 }}>POLIS AI · Signal Service</div>
        <div style={{ fontSize: 30, fontWeight: 900, color: "#0f172a", letterSpacing: "-0.03em" }}>
          💎 Premium Trading Signals
        </div>
        <div style={{ fontSize: 13, color: "#64748b", marginTop: 8 }}>
          รับสัญญาณ AI ทุก trade · ส่งตรงผ่าน Telegram ทันที
        </div>
      </div>

      {/* Benefits */}
      <div style={{ display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap", marginBottom: 32 }}>
        {["📡 Real-time Signals", "🤖 AI-Powered", "📊 Entry / TP / SL", "🎯 Win Rate Tracked"].map(b => (
          <div key={b} style={{ fontSize: 11, padding: "5px 12px", borderRadius: 20,
            background: "rgba(99,102,241,0.08)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.2)" }}>
            {b}
          </div>
        ))}
      </div>

      <div style={{ maxWidth: 800, margin: "0 auto", display: "grid",
        gridTemplateColumns: "1fr 1fr", gap: 20 }}>

        {/* Left */}
        <div>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase",
              letterSpacing: "0.1em", marginBottom: 12 }}>เลือกแผน</div>
            {Object.entries(plans).map(([key, p]) => {
              const c   = PLAN_COLORS[key] ?? "#10b981";
              const ico = PLAN_ICONS[key] ?? "📦";
              const active = selected === key;
              return (
                <div key={key} onClick={() => setSelected(key)} style={{
                  padding: "14px 16px", borderRadius: 12, marginBottom: 10, cursor: "pointer",
                  border: `2px solid ${active ? c : "rgba(0,0,0,0.07)"}`,
                  background: active ? `${c}0d` : "#fff",
                  transition: "all 0.15s",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <span style={{ fontSize: 13, fontWeight: 700, color: active ? c : "#0f172a" }}>
                        {ico} {p.label}
                      </span>
                      {p.save && (
                        <span style={{ marginLeft: 8, fontSize: 9, padding: "2px 7px", borderRadius: 10,
                          background: `${c}20`, color: c, fontWeight: 700 }}>{p.save}</span>
                      )}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 18, fontWeight: 900, color: active ? c : "#0f172a",
                        fontFamily: "var(--font-mono, monospace)" }}>฿{p.thb.toLocaleString()}</div>
                      <div style={{ fontSize: 9, color: "#94a3b8" }}>{p.days} วัน</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Form */}
          <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 14, padding: "18px 20px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase",
              letterSpacing: "0.1em", marginBottom: 14 }}>ข้อมูลของคุณ</div>

            {[
              { label: "Telegram Username *", key: "username",    placeholder: "@username" },
              { label: "Telegram ID (ถ้ามี)",  key: "telegram_id", placeholder: "เช่น 123456789 (ดูได้จาก @userinfobot)" },
              { label: "หมายเหตุ / เลขอ้างอิงสลิป", key: "slip_note", placeholder: "บอก ref หรือเวลาที่โอน" },
            ].map(f => (
              <div key={f.key} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 9, color: "#64748b", marginBottom: 4 }}>{f.label}</div>
                <input
                  type="text"
                  value={form[f.key as keyof typeof form]}
                  onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  title={f.label}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 7,
                    border: "1px solid rgba(0,0,0,0.1)", background: "#f8fafc",
                    color: "#0f172a", fontSize: 12, boxSizing: "border-box" }}
                />
              </div>
            ))}

            <div style={{ padding: "8px 10px", borderRadius: 7, background: "#fffbeb",
              border: "1px solid rgba(245,158,11,0.3)", fontSize: 10, color: "#92400e", marginBottom: 12 }}>
              💡 ใส่ Telegram ID เพื่อรับ invite link อัตโนมัติ — ดูได้โดย DM <strong>@userinfobot</strong>
            </div>

            {error && <div style={{ fontSize: 10, color: "#ef4444", marginBottom: 8 }}>⚠️ {error}</div>}

            <button type="button" onClick={submit} disabled={submitting} style={{
              width: "100%", padding: "10px", borderRadius: 9, fontSize: 13, fontWeight: 700,
              cursor: submitting ? "not-allowed" : "pointer",
              background: submitting ? "#94a3b8" : `linear-gradient(135deg,${color},${color}cc)`,
              color: "#fff", border: "none", marginTop: 4,
            }}>
              {submitting ? "กำลังส่ง…" : `✅ แจ้งชำระเงิน ฿${plan?.thb?.toLocaleString() ?? "—"}`}
            </button>

            <div style={{ fontSize: 9, color: "#94a3b8", textAlign: "center", marginTop: 10 }}>
              หลังแจ้ง admin จะตรวจสอบและอนุมัติภายใน 15 นาที
            </div>
          </div>
        </div>

        {/* Right — QR + Steps */}
        <div>
          <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 14,
            padding: "20px", textAlign: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase",
              letterSpacing: "0.1em", marginBottom: 16 }}>สแกน QR PromptPay</div>

            {qrLoading ? (
              <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center",
                color: "#94a3b8", fontSize: 11 }}>กำลังสร้าง QR…</div>
            ) : qr ? (
              <img src={`data:image/png;base64,${qr}`} alt="PromptPay QR"
                style={{ width: 220, height: 220, borderRadius: 8, border: "1px solid rgba(0,0,0,0.08)" }} />
            ) : (
              <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center",
                color: "#94a3b8", fontSize: 11 }}>ไม่พบ QR Code</div>
            )}

            {plan && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 24, fontWeight: 900, color, fontFamily: "var(--font-mono,monospace)" }}>
                  ฿{plan.thb.toLocaleString()}
                </div>
                <div style={{ fontSize: 11, color: "#64748b" }}>{plan.label} · {plan.days} วัน</div>
              </div>
            )}
          </div>

          <div style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 14, padding: "18px 20px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase",
              letterSpacing: "0.1em", marginBottom: 14 }}>วิธีสมัคร</div>
            {[
              ["1️⃣", "เลือกแผนที่ต้องการ"],
              ["2️⃣", "สแกน QR PromptPay โอนเงินตามยอด"],
              ["3️⃣", "กรอก Telegram username + ID"],
              ["4️⃣", "กด \"แจ้งชำระเงิน\""],
              ["5️⃣", "รอ admin อนุมัติ (~15 นาที) — หน้านี้จะอัปเดตเอง"],
              ["6️⃣", "รับ invite link เข้า channel ทันที 🎉"],
            ].map(([num, text]) => (
              <div key={num} style={{ display: "flex", gap: 10, marginBottom: 10, fontSize: 12 }}>
                <span style={{ flexShrink: 0 }}>{num}</span>
                <span style={{ color: "#475569" }}>{text}</span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
