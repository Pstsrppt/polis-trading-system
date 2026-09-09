"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import s from "./Sidebar.module.css";

const DEPARTMENTS: { href:string; icon:string; label:string; sublabel:string; color:string; status:"live"|"soon" }[] = [
  { href: "/trading", icon: "📊", label: "เทรด", sublabel: "ระบบเทรด AI", color: "#10b981", status: "live" },
];

const TRADING_SUB = [
  { href: "/trading",                icon: "⚡", label: "ภาพรวม"        },
  { href: "/trading/board",          icon: "🏢", label: "ห้องประชุม"    },
  { href: "/trading/portfolio",      icon: "💼", label: "พอร์ตโฟลิโอ"  },
  { href: "/trading/performance",     icon: "📈", label: "Performance"   },
  { href: "/trading/backtest",        icon: "🧪", label: "Backtest"       },
  { href: "/trading/calendar",        icon: "📅", label: "Calendar"       },
  { href: "/trading/hours",           icon: "⏰", label: "Best Hours"     },
  { href: "/trading/log",             icon: "📋", label: "Trade Log"      },
  { href: "/trading/soc",            icon: "🛡", label: "ศูนย์ควบคุม"   },
  { href: "/trading/notifications",  icon: "🔔", label: "การแจ้งเตือน"  },
  { href: "/trading/settings",       icon: "⚙️", label: "ตั้งค่า"        },
];

export default function Sidebar() {
  const pathname = usePathname();
  const onTrading = pathname.startsWith("/trading");

  return (
    <aside className={s.sidebar}>

      {/* Logo — links to home */}
      <Link href="/" style={{ textDecoration: "none" }}>
        <div className={s.logoArea}>
          <div className={s.logoRow}>
            <div className={s.logoIcon}>🏢</div>
            <div>
              <div className={s.logoName}>POLIS</div>
              <div className={s.logoSub}>Enterprise OS</div>
            </div>
          </div>
        </div>
      </Link>

      <div className={s.divider} />
      <div className={s.sectionLabel}>แผนก</div>

      {/* Nav */}
      <nav className={s.nav}>
        {DEPARTMENTS.map(dep => {
          const active = pathname.startsWith(dep.href);
          const soon   = dep.status === "soon";
          const cls    = [s.navItem, active && s.active, soon && s.soon].filter(Boolean).join(" ");
          return (
            <div key={dep.href}>
              <Link
                href={soon ? "#" : dep.href}
                onClick={soon ? e => e.preventDefault() : undefined}
                style={{ textDecoration: "none" }}
              >
                <div className={cls} style={{ ["--dep-color" as string]: dep.color }}>
                  <div className={s.navIconBox}>{dep.icon}</div>
                  <div className={s.navFlex}>
                    <div className={s.navLabel}>{dep.label}</div>
                    <div className={s.navSub}>{dep.sublabel}</div>
                  </div>
                  {active && !soon && <div className={s.liveDot} />}
                  {soon          && <span className={s.soonBadge}>เร็วๆ นี้</span>}
                </div>
              </Link>

              {/* Sub-nav for Trading */}
              {dep.href === "/trading" && onTrading && (
                <div className={s.subNav}>
                  {TRADING_SUB.map(sub => {
                    const isExact = sub.href === "/trading"
                      ? pathname === "/trading"
                      : pathname.startsWith(sub.href);
                    return (
                      <Link
                        key={sub.href}
                        href={sub.href}
                        className={[s.subNavItem, isExact && s.subNavActive].filter(Boolean).join(" ")}
                      >
                        <span className={s.subNavIcon}>{sub.icon}</span>
                        {sub.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* Add department */}
        <div className={s.addDept}>
          <div className={s.addIcon}>＋</div>
          <div className={s.addLabel}>เพิ่มแผนก</div>
        </div>
      </nav>

      {/* Footer */}
      <div className={s.footer}>
        <div className={s.footerDot} />
        <span className={s.footerText}>POLIS v0.1 · เบต้า</span>
        <button
          type="button"
          title="ออกจากระบบ"
          onClick={async () => {
            await fetch("/api/login", { method: "DELETE" });
            window.location.href = "/login";
          }}
          style={{ marginLeft: "auto", fontSize: 11, color: "#94a3b8", background: "none",
            border: "none", cursor: "pointer", padding: "2px 6px", borderRadius: 4 }}
        >ออก</button>
      </div>
    </aside>
  );
}
