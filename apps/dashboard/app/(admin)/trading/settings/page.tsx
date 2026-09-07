"use client";
import { useEffect, useState, useCallback } from "react";

const GW = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:19000";

type Settings = {
  paused: boolean;
  max_risk: number;
  min_confidence: number;
  atr_ratio: number;
  trading_hours_start: number;
  trading_hours_end: number;
  board_interval_s: number;
  signal_source: string;
  oanda_live: boolean;
};

/* ── Tiny UI atoms ───────────────────────────────────────────────────── */
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "#ffffff",
      border: "1px solid rgba(0,0,0,0.07)", borderRadius: 16, padding: "22px 24px",
      boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 4px 16px rgba(0,0,0,0.04)", ...style,
    }}>{children}</div>
  );
}

function SectionLabel({ icon, label, accent = "#6366f1", sub }: { icon: string; label: string; accent?: string; sub?: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      margin: "28px 0 14px", padding: "10px 16px", borderRadius: 10,
      background: `linear-gradient(90deg,${accent}14,transparent)`,
      borderLeft: `3px solid ${accent}`,
    }}>
      <span style={{ fontSize: 15 }}>{icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: "#1e293b", letterSpacing: "0.12em", textTransform: "uppercase" as const }}>{label}</div>
        {sub && <div style={{ fontSize: 9, color: "#64748b", marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

function Row({ label, sub, children }: { label: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 0", borderBottom: "1px solid rgba(0,0,0,0.04)" }}>
      <div>
        <div style={{ fontSize: 12, color: "#334155", fontWeight: 600 }}>{label}</div>
        {sub && <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>{sub}</div>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, col = "#10b981" }: { on: boolean; onChange: (v: boolean) => void; col?: string }) {
  return (
    <button type="button" onClick={() => onChange(!on)} style={{
      width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer", position: "relative",
      background: on ? col : "rgba(0,0,0,0.06)", transition: "background 0.2s",
    }}>
      <div style={{
        position: "absolute", top: 3, left: on ? 23 : 3, width: 18, height: 18,
        borderRadius: "50%", background: "#fff", transition: "left 0.2s",
        boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
      }} />
    </button>
  );
}

function Slider({
  value, min, max, step, onChange, format, col = "#6366f1",
}: {
  value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; format: (v: number) => string; col?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{
        minWidth: 56, textAlign: "right" as const, fontSize: 16, fontWeight: 800,
        color: col, fontFamily: "var(--font-mono,monospace)",
      }}>{format(value)}</div>
      <div style={{ position: "relative", width: 160, height: 20, display: "flex", alignItems: "center" }}>
        <div style={{ width: "100%", height: 4, borderRadius: 2, background: "rgba(0,0,0,0.06)", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: `linear-gradient(90deg,${col}88,${col})`, borderRadius: 2 }} />
        </div>
        <input
          type="range" min={min} max={max} step={step} value={value}
          aria-label={format(value)}
          onChange={e => onChange(Number(e.target.value))}
          style={{ position: "absolute", width: "100%", opacity: 0, cursor: "pointer", height: "100%" }}
        />
      </div>
    </div>
  );
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  const col = ok ? "#10b981" : "#f59e0b";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ width: 6, height: 6, borderRadius: "50%", background: col, boxShadow: `0 0 6px ${col}` }} />
      <span style={{ fontSize: 11, fontWeight: 700, color: col }}>{label}</span>
    </div>
  );
}

const SYMBOL_META: Record<string,{icon:string;color:string;label:string}> = {
  XAUUSD: {icon:"🥇",color:"#fbbf24",label:"XAU/USD"},
  EURUSD: {icon:"💶",color:"#22d3ee",label:"EUR/USD"},
  GBPUSD: {icon:"🇬🇧",color:"#818cf8",label:"GBP/USD"},
  BTCUSD: {icon:"🟠",color:"#f97316",label:"BTC/USD"},
  XAGUSD: {icon:"🥈",color:"#94a3b8",label:"XAG/USD"},
};

const CONTRACT_UNITS: Record<string,number> = {
  XAUUSD:100, EURUSD:100_000, GBPUSD:100_000, BTCUSD:1, XAGUSD:5_000,
};

/* ── TradingView Webhook Card ────────────────────────────────────────────── */
function TradingViewWebhookCard({ gw }: { gw: string }) {
  const [copied, setCopied] = useState(false);
  const webhookUrl = `${gw}/webhook/tradingview?secret=YOUR_SECRET`;
  const payload = `{
  "symbol": "{{ticker}}",
  "direction": "{{strategy.order.action}}",
  "price": {{close}},
  "atr": {{ta.atr(14)}},
  "confidence": 75
}`;

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
      <div>
        <div style={{ fontSize: 9, fontWeight: 700, color: "#475569", textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: 8 }}>Webhook URL</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <div style={{ flex: 1, padding: "8px 10px", borderRadius: 8, background: "#f8fafc",
            border: "1px solid rgba(0,0,0,0.1)", fontFamily: "var(--font-mono,monospace)",
            fontSize: 10, color: "#334155", wordBreak: "break-all" as const }}>
            {webhookUrl.replace("YOUR_SECRET", "••••••••")}
          </div>
          <button type="button" onClick={() => copy(webhookUrl)} style={{
            padding: "8px 14px", borderRadius: 8, fontSize: 11, fontWeight: 700,
            background: copied ? "rgba(16,185,129,0.12)" : "rgba(41,98,255,0.1)",
            color: copied ? "#10b981" : "#2962ff", border: "none", cursor: "pointer", whiteSpace: "nowrap" as const,
          }}>{copied ? "✅ Copied" : "Copy"}</button>
        </div>
        <div style={{ fontSize: 10, color: "#64748b", lineHeight: 1.8 }}>
          <div>1️⃣ ใน TradingView → Alert → Notifications</div>
          <div>2️⃣ เลือก <b>Webhook URL</b> ใส่ URL ด้านบน</div>
          <div>3️⃣ แทน <code style={{ color: "#2962ff" }}>YOUR_SECRET</code> ด้วยค่าใน <code>.env TRADINGVIEW_WEBHOOK_SECRET</code></div>
          <div>4️⃣ ใส่ JSON ด้านขวาใน <b>Message</b></div>
        </div>
        <div style={{ marginTop: 12, padding: "8px 10px", borderRadius: 8,
          background: "rgba(41,98,255,0.06)", border: "1px solid rgba(41,98,255,0.2)", fontSize: 10, color: "#1e40af" }}>
          💡 signal จะเข้า POLIS ทันทีที่ Alert ถูก trigger — ไม่ต้อง poll TwelveData
        </div>
      </div>
      <div>
        <div style={{ fontSize: 9, fontWeight: 700, color: "#475569", textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: 8 }}>
          Alert Message (JSON)
        </div>
        <div style={{ position: "relative" as const }}>
          <pre style={{ margin: 0, padding: "12px 14px", borderRadius: 8,
            background: "#0f172a", color: "#e2e8f0", fontSize: 10,
            fontFamily: "var(--font-mono,monospace)", lineHeight: 1.7,
            overflow: "auto" as const }}>
            {payload}
          </pre>
          <button type="button" onClick={() => copy(payload)} style={{
            position: "absolute" as const, top: 8, right: 8,
            padding: "4px 10px", borderRadius: 6, fontSize: 9, fontWeight: 700,
            background: "rgba(255,255,255,0.1)", color: "#94a3b8", border: "none", cursor: "pointer",
          }}>Copy</button>
        </div>
        <div style={{ marginTop: 8, fontSize: 9, color: "#94a3b8", lineHeight: 1.7 }}>
          direction: "buy" หรือ "sell" · confidence: 60–100<br />
          atr ใส่ค่าจริงหรือ 0 ก็ได้ (filter จะ skip ถ้า = 0)
        </div>
      </div>
    </div>
  );
}

/* ══ SETTINGS PAGE ═══════════════════════════════════════════════════════ */
export default function SettingsPage() {
  const [s, setS]           = useState<Settings | null>(null);
  const [draft, setDraft]   = useState<Partial<Settings>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const [err, setErr]       = useState("");
  const [boardBusy, setBoardBusy] = useState(false);

  // Symbol toggles
  const [symbols,     setSymbols]     = useState<Record<string,boolean>>({});
  const [symSaving,   setSymSaving]   = useState(false);

  // World prices for calculator auto-fill
  const [worldPx, setWorldPx] = useState<Record<string,number>>({});
  useEffect(()=>{
    fetch(`${GW}/world`).then(r=>r.json()).then((d:Record<string,number>)=>{
      setWorldPx({
        XAUUSD: d.gold_price ?? 0,
        EURUSD: d.eur_price  ?? 0,
        BTCUSD: d.btc_price  ?? 0,
      });
    }).catch(()=>{});
  },[]);

  // Position calculator
  const [calcSym,     setCalcSym]     = useState("XAUUSD");
  const [calcPrice,   setCalcPrice]   = useState("");
  const [calcStop,    setCalcStop]    = useState("");
  const [calcRisk,    setCalcRisk]    = useState(0.006);
  const [calcBalance, setCalcBalance] = useState(10000);

  const load = useCallback(() => {
    fetch(`${GW}/settings`).then(r => r.json()).then((d: Settings) => {
      setS(d);
      setDraft(d);
      setCalcRisk(d.max_risk ?? 0.006);
    }).catch(() => setErr("Cannot reach gateway"));
    fetch(`${GW}/settings/symbols`).then(r => r.json()).then(setSymbols).catch(()=>{});
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveSymbols = async () => {
    setSymSaving(true);
    try {
      await fetch(`${GW}/settings/symbols`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify(symbols),
      });
    } finally { setSymSaving(false); }
  };

  // Position calculator
  const price    = parseFloat(calcPrice) || 0;
  const stopDist = parseFloat(calcStop)  || 0;
  const units    = CONTRACT_UNITS[calcSym] ?? 100;
  const calcLots = (price > 0 && stopDist > 0)
    ? Math.max(0.01, Math.min(100, Math.round((calcBalance * calcRisk) / (stopDist * units) * 100) / 100))
    : null;
  const calcRiskUsd = calcLots ? Math.round(stopDist * units * calcLots * 100) / 100 : null;

  const get = <K extends keyof Settings>(k: K): Settings[K] =>
    (draft[k] !== undefined ? draft[k] : s?.[k]) as Settings[K];

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setDraft(prev => ({ ...prev, [k]: v }));

  const save = async () => {
    setSaving(true); setErr(""); setSaved(false);
    try {
      // pause/resume first if changed
      if (draft.paused !== undefined && draft.paused !== s?.paused) {
        await fetch(`${GW}/control/${draft.paused ? "pause" : "resume"}`, { method: "POST" });
      }
      // other settings
      const body: Record<string, unknown> = {};
      for (const k of ["max_risk", "min_confidence", "atr_ratio", "trading_hours_start", "trading_hours_end", "board_interval_s"] as const) {
        if (draft[k] !== undefined) body[k] = draft[k];
      }
      if (Object.keys(body).length > 0) {
        await fetch(`${GW}/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      }
      setSaved(true);
      load();
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setErr("Save failed — check gateway");
    } finally {
      setSaving(false);
    }
  };

  const triggerBoard = async () => {
    setBoardBusy(true);
    await fetch(`${GW}/control/board`, { method: "POST" }).catch(() => {});
    setTimeout(() => setBoardBusy(false), 2000);
  };

  if (!s) return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "#64748b", fontSize: 12, fontStyle: "italic" }}>
        {err || "Loading settings…"}
      </div>
    </div>
  );

  const paused = get("paused") as boolean;
  const maxRisk = get("max_risk") as number;
  const minConf = get("min_confidence") as number;
  const atrRatio = get("atr_ratio") as number;
  const hStart = get("trading_hours_start") as number;
  const hEnd = get("trading_hours_end") as number;
  const boardInt = get("board_interval_s") as number;

  return (
    <div className="dot-bg" style={{ minHeight: "100vh", background: "var(--bg)", padding: "24px 28px 56px" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.12em", textTransform: "uppercase" as const, marginBottom: 6 }}>
            POLIS HQ › เทรด › ตั้งค่า
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em", color: "#0f172a", lineHeight: 1 }}>การตั้งค่าระบบ</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>ควบคุมความเสี่ยง · กรองสัญญาณ · ตารางเทรด</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {saved && <span style={{ fontSize: 11, color: "#10b981", fontWeight: 600 }}>✓ บันทึกแล้ว</span>}
          {err   && <span style={{ fontSize: 11, color: "#ef4444" }}>{err}</span>}
          <button type="button" onClick={load} style={{ padding: "7px 14px", borderRadius: 9, border: "1px solid rgba(0,0,0,0.07)", background: "rgba(0,0,0,0.03)", color: "#64748b", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>
            ↻ Reload
          </button>
          <button type="button" onClick={save} disabled={saving} style={{
            padding: "7px 20px", borderRadius: 9, border: "none", fontWeight: 700, fontSize: 12,
            cursor: saving ? "default" : "pointer",
            background: saving ? "rgba(99,102,241,0.3)" : "linear-gradient(135deg,#6366f1,#818cf8)",
            color: "#fff", boxShadow: saving ? "none" : "0 2px 12px rgba(99,102,241,0.4)",
          }}>
            {saving ? "กำลังบันทึก…" : "บันทึกการเปลี่ยนแปลง"}
          </button>
        </div>
      </div>

      {/* System Info */}
      <SectionLabel icon="🖥" label="ข้อมูลระบบ" accent="#22d3ee" sub="อ่านได้อย่างเดียว — ตั้งค่าผ่าน environment variables" />
      <Card>
        <Row label="แหล่งสัญญาณ" sub="แหล่งที่มาของสัญญาณเทรด">
          <div style={{ padding: "4px 12px", borderRadius: 6, background: "rgba(34,211,238,0.1)", border: "1px solid rgba(34,211,238,0.25)", fontSize: 11, fontWeight: 700, color: "#22d3ee" }}>
            {s.signal_source.toUpperCase()}
          </div>
        </Row>
        <Row label="โหมดโบรกเกอร์" sub="ตั้ง OANDA_ENABLED=true เพื่อซื้อขายจริง">
          <StatusBadge ok={s.oanda_live} label={s.oanda_live ? "Live (Oanda)" : "Simulation"} />
        </Row>
        <Row label="Gateway" sub={GW}>
          <StatusBadge ok label="Connected" />
        </Row>
      </Card>

      {/* ควบคุมการเทรด */}
      <SectionLabel icon="⚡" label="ควบคุมการเทรด" accent="#10b981" sub="การเปลี่ยนแปลงมีผลทันทีผ่าน Redis" />
      <Card>
        <Row label="เปิดการเทรด" sub={paused ? "บล็อกสัญญาณทั้งหมด — ระบบหยุดชั่วคราว" : "ระบบรับและประมวลผลสัญญาณตามปกติ"}>
          <Toggle on={!paused} onChange={v => set("paused", !v)} col="#10b981" />
          <span style={{ fontSize: 11, fontWeight: 700, color: paused ? "#ef4444" : "#10b981", minWidth: 50 }}>
            {paused ? "PAUSED" : "ACTIVE"}
          </span>
        </Row>
        <Row label="ความเสี่ยงสูงสุด/ออเดอร์" sub="สัดส่วนทุนที่เสี่ยงต่อออเดอร์ (0.2% – 1.0%)">
          <Slider value={maxRisk} min={0.002} max={0.010} step={0.001}
            format={v => `${(v * 100).toFixed(1)}%`}
            col={maxRisk <= 0.003 ? "#ef4444" : maxRisk >= 0.008 ? "#10b981" : "#f59e0b"}
            onChange={v => set("max_risk", v)} />
        </Row>
      </Card>

      {/* Signal Filter */}
      <SectionLabel icon="🔬" label="ตัวกรองสัญญาณ" accent="#f59e0b" sub="บันทึกใน Redis — kernel อ่านโดยไม่ต้อง restart" />
      <Card>
        <div style={{ display: "flex", gap: 8, padding: "8px 12px", borderRadius: 9, background: "rgba(245,158,11,0.07)", border: "1px solid rgba(245,158,11,0.2)", marginBottom: 14, fontSize: 10, color: "#92400e" }}>
          ⚠️ Signal filter changes are saved to Redis and applied after kernel restart. Trading control changes above are immediate.
        </div>
        <Row label="ความเชื่อมั่นขั้นต่ำ" sub="สัญญาณที่ต่ำกว่า % นี้จะถูกปฏิเสธ (40–95%)">
          <Slider value={minConf} min={40} max={95} step={5}
            format={v => `${v}%`} col="#f59e0b"
            onChange={v => set("min_confidence", v)} />
        </Row>
        <Row label="ATR / Spread ขั้นต่ำ" sub="ATR ต้องมากกว่า N× ของ spread (1.0–10.0)">
          <Slider value={atrRatio} min={1.0} max={10.0} step={0.5}
            format={v => `${v.toFixed(1)}×`} col="#f59e0b"
            onChange={v => set("atr_ratio", v)} />
        </Row>
      </Card>

      {/* Trading Hours */}
      <SectionLabel icon="🕐" label="เวลาเทรด (UTC)" accent="#8b5cf6" sub="บันทึกใน Redis — kernel อ่านโดยไม่ต้อง restart" />
      <Card>
        <Row label="Session Start" sub="UTC hour to begin accepting signals (0–23)">
          <Slider value={hStart} min={0} max={23} step={1}
            format={v => `${v.toString().padStart(2,"0")}:00 UTC`} col="#8b5cf6"
            onChange={v => set("trading_hours_start", v)} />
        </Row>
        <Row label="Session End" sub="UTC hour to stop accepting signals (0–23)">
          <Slider value={hEnd} min={0} max={23} step={1}
            format={v => `${v.toString().padStart(2,"0")}:00 UTC`} col="#8b5cf6"
            onChange={v => set("trading_hours_end", v)} />
        </Row>
        <div style={{ padding: "10px 12px", borderRadius: 9, background: "rgba(139,92,246,0.07)", border: "1px solid rgba(139,92,246,0.18)", marginTop: 8, fontSize: 10, color: "#6d28d9" }}>
          Active window: {hStart.toString().padStart(2,"0")}:00 – {hEnd.toString().padStart(2,"0")}:00 UTC
          &nbsp;·&nbsp;
          {((hEnd - hStart + 24) % 24)} hours/day
          &nbsp;·&nbsp;
          Bangkok: {((hStart + 7) % 24).toString().padStart(2,"0")}:00 – {((hEnd + 7) % 24).toString().padStart(2,"0")}:00
        </div>
      </Card>

      {/* Board Meeting */}
      <SectionLabel icon="🏢" label="Board Meeting" accent="#ec4899" />
      <Card>
        <Row label="Meeting Interval" sub="How often the board convenes (1min – 1hr)">
          <Slider value={boardInt} min={60} max={3600} step={60}
            format={v => v < 120 ? `${v}s` : `${Math.round(v / 60)}min`} col="#ec4899"
            onChange={v => set("board_interval_s", v)} />
        </Row>
        <Row label="Force Board Meeting" sub="Trigger an emergency session immediately">
          <button type="button" onClick={triggerBoard} disabled={boardBusy} style={{
            padding: "7px 18px", borderRadius: 9, border: "1px solid rgba(236,72,153,0.4)",
            background: boardBusy ? "rgba(236,72,153,0.05)" : "rgba(236,72,153,0.12)",
            color: boardBusy ? "#6b2742" : "#ec4899", fontSize: 11, fontWeight: 700,
            cursor: boardBusy ? "default" : "pointer", transition: "all 0.2s",
          }}>
            {boardBusy ? "เรียกประชุมแล้ว…" : "⚡ Trigger Now"}
          </button>
        </Row>
      </Card>

      {/* ── Symbol Toggles ── */}
      <SectionLabel icon="📌" label="สินทรัพย์ที่ใช้งาน" accent="#f97316" sub="Toggle to enable/disable trading per symbol" />
      <Card>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:8, marginBottom:16 }}>
          {Object.entries(SYMBOL_META).map(([sym,m])=>{
            const on = symbols[sym] ?? false;
            return(
              <div key={sym} style={{
                padding:"12px 10px", borderRadius:12, textAlign:"center" as const,
                background: on ? `${m.color}14` : "#f8fafc",
                border: `1px solid ${on ? m.color+"40" : "rgba(0,0,0,0.05)"}`,
                cursor:"pointer", transition:"all 0.2s",
              }} onClick={()=>setSymbols(p=>({...p,[sym]:!p[sym]}))}>
                <div style={{fontSize:20,marginBottom:5}}>{m.icon}</div>
                <div style={{fontSize:10,fontWeight:700,color:on?m.color:"#475569",fontFamily:"var(--font-mono,monospace)"}}>{m.label}</div>
                <div style={{fontSize:8,marginTop:4,color:on?"#10b981":"#475569",fontWeight:700}}>{on?"ACTIVE":"DISABLED"}</div>
              </div>
            );
          })}
        </div>
        <button type="button" onClick={saveSymbols} disabled={symSaving} style={{
          padding:"8px 20px", borderRadius:8, fontSize:12, fontWeight:700,
          background:"rgba(249,115,22,0.15)", border:"1px solid rgba(249,115,22,0.35)",
          color:symSaving?"#475569":"#f97316", cursor:symSaving?"default":"pointer",
        }}>{symSaving?"Saving…":"บันทึกการตั้งค่าสินทรัพย์"}</button>
      </Card>

      {/* ── Position Size Calculator ── */}
      <SectionLabel icon="🧮" label="คำนวณขนาดโพซิชัน" accent="#818cf8" sub="Calculate lot size from risk parameters" />
      <Card>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:10, marginBottom:16 }}>
          {/* Symbol picker */}
          <div>
            <div style={{fontSize:9,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.08em",marginBottom:6}}>Symbol</div>
            <div style={{display:"flex",flexDirection:"column" as const,gap:4}}>
              {Object.entries(SYMBOL_META).slice(0,4).map(([sym,m])=>(
                <button key={sym} type="button" onClick={()=>{
                  setCalcSym(sym);
                  if(worldPx[sym]) setCalcPrice(worldPx[sym].toString());
                }} style={{
                  padding:"4px 8px",borderRadius:6,fontSize:10,fontWeight:calcSym===sym?700:400,
                  cursor:"pointer",textAlign:"left" as const,
                  border:`1px solid ${calcSym===sym?m.color+"50":"rgba(0,0,0,0.05)"}`,
                  background:calcSym===sym?`${m.color}12`:"transparent",
                  color:calcSym===sym?m.color:"#64748b",
                }}>{m.icon} {m.label}</button>
              ))}
            </div>
          </div>
          {/* Inputs */}
          <div style={{display:"flex",flexDirection:"column" as const,gap:8}}>
            {[
              {label:"Entry Price",val:calcPrice,set:setCalcPrice,placeholder:"e.g. 2340"},
              {label:"Stop Distance",val:calcStop,set:setCalcStop,placeholder:"e.g. 9.00"},
            ].map(f=>(
              <div key={f.label}>
                <div style={{fontSize:9,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.08em",marginBottom:4}}>{f.label}</div>
                <input type="number" step="any" value={f.val} placeholder={f.placeholder}
                  title={f.label}
                  onChange={e=>f.set(e.target.value)}
                  style={{width:"100%",padding:"6px 10px",borderRadius:7,
                    border:"1px solid rgba(0,0,0,0.08)",background:"#f8fafc",
                    color:"#f1f5f9",fontSize:12,fontFamily:"var(--font-mono,monospace)"}}/>
              </div>
            ))}
          </div>
          {/* Risk sliders */}
          <div style={{display:"flex",flexDirection:"column" as const,gap:8}}>
            <div>
              <div style={{fontSize:9,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.08em",marginBottom:4}}>Risk % ({(calcRisk*100).toFixed(1)}%)</div>
              <input type="range" min={0.002} max={0.010} step={0.001} value={calcRisk}
                title="Risk percentage"
                onChange={e=>setCalcRisk(parseFloat(e.target.value))}
                style={{width:"100%"}}/>
            </div>
            <div>
              <div style={{fontSize:9,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.08em",marginBottom:4}}>Balance ($)</div>
              <input type="number" value={calcBalance} title="Account balance"
                onChange={e=>setCalcBalance(parseFloat(e.target.value)||10000)}
                style={{width:"100%",padding:"6px 10px",borderRadius:7,
                  border:"1px solid rgba(0,0,0,0.08)",background:"#f8fafc",
                  color:"#f1f5f9",fontSize:12,fontFamily:"var(--font-mono,monospace)"}}/>
            </div>
          </div>
          {/* Result */}
          <div style={{display:"flex",flexDirection:"column" as const,justifyContent:"center",gap:10}}>
            {calcLots!=null?(
              <>
                <div style={{padding:"12px 14px",borderRadius:10,background:"rgba(99,102,241,0.08)",border:"1px solid rgba(99,102,241,0.25)"}}>
                  <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.08em",marginBottom:3}}>Lot Size</div>
                  <div style={{fontSize:28,fontWeight:900,color:"#818cf8",fontFamily:"var(--font-mono,monospace)",lineHeight:1}}>{calcLots.toFixed(2)}</div>
                </div>
                <div style={{padding:"10px 14px",borderRadius:10,background:"rgba(16,185,129,0.06)",border:"1px solid rgba(16,185,129,0.2)"}}>
                  <div style={{fontSize:8,color:"#475569",textTransform:"uppercase" as const,letterSpacing:"0.08em",marginBottom:3}}>Risk USD</div>
                  <div style={{fontSize:20,fontWeight:800,color:"#10b981",fontFamily:"var(--font-mono,monospace)",lineHeight:1}}>${calcRiskUsd?.toFixed(2)}</div>
                </div>
              </>
            ):(
              <div style={{color:"#334155",fontSize:11,textAlign:"center" as const,fontStyle:"italic"}}>
                ใส่ราคาและ stop distance
              </div>
            )}
          </div>
        </div>
        <div style={{fontSize:9,color:"#334155"}}>
          Formula: lots = (balance × risk%) ÷ (stop × {CONTRACT_UNITS[calcSym]?.toLocaleString()} units/lot) · Max 100 lots
        </div>
      </Card>

      {/* TradingView Webhook */}
      <SectionLabel icon="📡" label="TradingView Webhook" accent="#2962ff" sub="ส่ง signal จาก TradingView Alert เข้า POLIS โดยตรง" />
      <Card>
        <TradingViewWebhookCard gw={GW} />
      </Card>

      {/* สรุปความเสี่ยง */}
      <SectionLabel icon="📊" label="สรุปความเสี่ยง" accent="#34d399" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
        {[
          { label: "Max Risk", value: `${(maxRisk * 100).toFixed(1)}%`, col: maxRisk <= 0.003 ? "#ef4444" : maxRisk >= 0.008 ? "#10b981" : "#f59e0b" },
          { label: "เชื่อมั่นขั้นต่ำ", value: `${minConf}%`, col: "#f59e0b" },
          { label: "ATR/Spread", value: `≥${atrRatio.toFixed(1)}×`, col: "#22d3ee" },
          { label: "ชั่วโมง/วัน", value: `${((hEnd - hStart + 24) % 24)}h`, col: "#8b5cf6" },
        ].map(k => (
          <div key={k.label} style={{ background: `${k.col}0d`, border: `1px solid ${k.col}28`, borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ fontSize: 8, color: `${k.col}99`, letterSpacing: "0.1em", textTransform: "uppercase" as const, marginBottom: 4, fontWeight: 700 }}>{k.label}</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: k.col, fontFamily: "var(--font-mono,monospace)", lineHeight: 1 }}>{k.value}</div>
          </div>
        ))}
      </div>

    </div>
  );
}
