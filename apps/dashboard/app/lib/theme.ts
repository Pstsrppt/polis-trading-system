/**
 * POLIS Light Theme — soft, warm, easy on the eyes
 * Inspired by Linear / Vercel dashboard aesthetic
 */

// ── Backgrounds ──────────────────────────────────────────────────────────────
export const BG        = "#f0f4f8";   // warm blue-gray — main page
export const BG_CARD   = "#ffffff";   // pure white card
export const BG_CARD2  = "#f8fafc";   // subtle off-white second level
export const BG_INPUT  = "#f8fafc";   // input fields
export const BG_DARK   = "#1e293b";   // dark accent (buttons, badges)

// ── Text ─────────────────────────────────────────────────────────────────────
export const TEXT      = "#0f172a";   // slate-900 — primary text
export const TEXT2     = "#334155";   // slate-700 — secondary text
export const TEXT3     = "#64748b";   // slate-500 — tertiary / labels
export const TEXT4     = "#94a3b8";   // slate-400 — muted / placeholders
export const TEXT5     = "#cbd5e1";   // slate-300 — very faint

// ── Borders & Dividers ───────────────────────────────────────────────────────
export const BORDER    = "rgba(0,0,0,0.07)";
export const BORDER2   = "rgba(0,0,0,0.04)";
export const DIVIDER   = "rgba(0,0,0,0.05)";

// ── Shadows ──────────────────────────────────────────────────────────────────
export const SHADOW_SM = "0 1px 2px rgba(0,0,0,0.05)";
export const SHADOW    = "0 1px 3px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04)";
export const SHADOW_LG = "0 4px 12px rgba(0,0,0,0.08), 0 16px 40px rgba(0,0,0,0.06)";

// ── Brand colors (same, work fine on light) ──────────────────────────────────
export const GREEN     = "#10b981";
export const RED       = "#ef4444";
export const YELLOW    = "#f59e0b";
export const BLUE      = "#3b82f6";
export const PURPLE    = "#818cf8";
export const CYAN      = "#22d3ee";
export const ORANGE    = "#f97316";
export const PINK      = "#ec4899";

// ── Card style helper ─────────────────────────────────────────────────────────
export const card = (accent?: string): React.CSSProperties => ({
  background: BG_CARD,
  border:     `1px solid ${accent ? accent + "30" : BORDER}`,
  borderRadius: 14,
  padding:    "18px 20px",
  boxShadow:  SHADOW,
});

// ── Status → color ────────────────────────────────────────────────────────────
export const statusColor = (s: string) =>
  s==="ok" ? GREEN : s==="warn" ? YELLOW : RED;

// ── Prevent TS import error in files without React ───────────────────────────
import type React from "react";
