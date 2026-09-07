"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginForm() {
  const [pw, setPw]       = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router       = useRouter();
  const searchParams = useSearchParams();
  const from         = searchParams.get("from") ?? "/";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError("");
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    if (r.ok) {
      router.replace(from);
    } else {
      const d = await r.json();
      setError(d.error ?? "รหัสผ่านไม่ถูกต้อง");
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center",
      justifyContent: "center", background: "linear-gradient(135deg,#f8fafc,#f0f4f8)" }}>
      <div style={{ width: 360, background: "#fff", borderRadius: 20,
        boxShadow: "0 4px 40px rgba(0,0,0,0.08)", padding: "40px 36px" }}>

        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, margin: "0 auto 16px",
            background: "linear-gradient(135deg,#10b981,#6366f1)",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>🏢</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#0f172a", letterSpacing: "-0.03em" }}>POLIS HQ</div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>Admin Dashboard</div>
        </div>

        <form onSubmit={submit}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: "#64748b", fontWeight: 700,
              textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>รหัสผ่าน</div>
            <input
              type="password"
              value={pw}
              onChange={e => setPw(e.target.value)}
              placeholder="••••••••"
              autoFocus
              style={{ width: "100%", padding: "10px 12px", borderRadius: 9,
                border: "1.5px solid rgba(0,0,0,0.1)", background: "#f8fafc",
                fontSize: 14, color: "#0f172a", boxSizing: "border-box",
                outline: "none" }}
            />
          </div>

          {error && (
            <div style={{ fontSize: 11, color: "#ef4444", marginBottom: 12,
              padding: "8px 12px", background: "#fef2f2", borderRadius: 7 }}>
              ⚠️ {error}
            </div>
          )}

          <button type="submit" disabled={loading || !pw} style={{
            width: "100%", padding: "11px", borderRadius: 10, fontSize: 14,
            fontWeight: 700, cursor: loading || !pw ? "not-allowed" : "pointer",
            background: loading || !pw
              ? "#e2e8f0"
              : "linear-gradient(135deg,#10b981,#6366f1)",
            color: loading || !pw ? "#94a3b8" : "#fff",
            border: "none", transition: "all 0.15s",
          }}>
            {loading ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
          </button>
        </form>

        <div style={{ textAlign: "center", marginTop: 24, fontSize: 10, color: "#cbd5e1" }}>
          🤖 POLIS AI Enterprise OS
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
