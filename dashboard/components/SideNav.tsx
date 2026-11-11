"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./Icon";

const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Overview", icon: "home" },
  { href: "/credit-unions", label: "Credit unions", icon: "users" },
  { href: "/offerings", label: "Offerings", icon: "compass" },
  { href: "/oncu", label: "ONCU data", icon: "chart" },
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
            {n.href === "/credit-unions" && pending > 0 && <span className="nav-badge" aria-label={`${pending} statements waiting for you`}>{pending}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
