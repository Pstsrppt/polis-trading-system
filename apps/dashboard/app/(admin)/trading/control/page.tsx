"use client";
import { useState } from "react";
import SocPage      from "../soc/page";
import SettingsPage from "../settings/page";
import BoardPage    from "../board/page";

const TABS = [
  { id: "soc",      label: "🛡 ศูนย์ควบคุม", C: SocPage },
  { id: "settings", label: "⚙️ ตั้งค่า",      C: SettingsPage },
  { id: "board",    label: "🏢 ห้องประชุม",   C: BoardPage },
];

export default function ControlPage() {
  const [tab, setTab] = useState("soc");
  const active = TABS.find(t => t.id === tab)!;
  return (
    <div>
      <div style={{ display:"flex", gap:4, padding:"12px 16px 0", borderBottom:"1px solid #e2e8f0", background:"#fff", position:"sticky", top:0, zIndex:10 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding:"8px 18px", borderRadius:"8px 8px 0 0", border:"none", cursor:"pointer",
            fontWeight: tab === t.id ? 700 : 400,
            background: tab === t.id ? "#0f172a" : "transparent",
            color:      tab === t.id ? "#fff"    : "#64748b",
            fontSize: 13, transition:"all 0.15s",
          }}>{t.label}</button>
        ))}
      </div>
      <active.C />
    </div>
  );
}
