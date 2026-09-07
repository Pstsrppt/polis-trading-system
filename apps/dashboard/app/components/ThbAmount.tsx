"use client";

interface ThbAmountProps {
  value: number;
  size?: "sm" | "md" | "lg" | "xl";
  showSign?: boolean;
  color?: string;
}

const SIZE = {
  sm: { sym: 9,  num: 13 },
  md: { sym: 10, num: 16 },
  lg: { sym: 12, num: 22 },
  xl: { sym: 14, num: 30 },
};

export default function ThbAmount({ value, size = "md", showSign, color }: ThbAmountProps) {
  const { sym, num } = SIZE[size];
  const isPos  = value >= 0;
  const col    = color ?? (isPos ? "#10b981" : "#ef4444");
  const sign   = showSign ? (isPos ? "+" : "−") : value < 0 ? "−" : "";
  const abs    = Math.abs(value).toLocaleString("th-TH", { maximumFractionDigits: 0 });

  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 2, color: col }}>
      {sign && (
        <span style={{ fontSize: sym, fontWeight: 700, lineHeight: 1, opacity: 0.85 }}>{sign}</span>
      )}
      <span style={{ fontSize: sym, fontWeight: 800, lineHeight: 1, letterSpacing: "0.02em", opacity: 0.75 }}>฿</span>
      <span style={{ fontSize: num, fontWeight: 900, lineHeight: 1, fontFamily: "var(--font-mono,monospace)", letterSpacing: "-0.02em" }}>
        {abs}
      </span>
    </span>
  );
}
