"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./Icon";

const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Overview", icon: "home" },
  { href: "/approvals", label: "Needs your OK", icon: "check" },
  { href: "/team", label: "Your team", icon: "team" },
  { href: "/studio", label: "Content studio", icon: "sparkle" },
  { href: "/customers", label: "Customers", icon: "users" },
  { href: "/digest", label: "Reports", icon: "chart" },
  { href: "/demo", label: "Demo", icon: "play" },
  { href: "/profile/connections", label: "Connections", icon: "plug" },
];

export function SideNav({ pending }: { pending: number }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="side-nav">
      {NAV.map((n) => {
        const on = n.href === "/" ? path === "/" : path.startsWith(n.href);
        return (
          <Link key={n.href} href={n.href} className={on ? "on" : ""} aria-current={on ? "page" : undefined}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
            {n.href === "/approvals" && pending > 0 && <span className="nav-badge" aria-label={`${pending} waiting`}>{pending}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
