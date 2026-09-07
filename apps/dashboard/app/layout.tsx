import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["300", "400", "500", "600", "700", "800"],
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "POLIS",
  description: "POLIS AI Trading Signals",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "POLIS",
  },
  other: {
    "mobile-web-app-capable": "yes",
    "msapplication-TileColor": "#6366f1",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" className={`${inter.variable} ${mono.variable}`}>
      <body style={{ margin: 0, background: "var(--bg)", color: "var(--text)",
        fontFamily: "var(--font-sans, sans-serif)" }}>
        {children}
      </body>
    </html>
  );
}
