"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./Icon";

const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Overview", icon: "home" },
  { href: "/credit-unions", label: "Credit unions", icon: "users" },
  { href: "/videos", label: "Videos", icon: "film" },
  { href: "/sharing", label: "Sharing", icon: "send" },
  { href: "/learning", label: "Learning", icon: "book" },
  { href: "/offerings", label: "Offerings", icon: "compass" },
  { href: "/oncu", label: "ONCU data", icon: "chart" },
  { href: "/profile", label: "Profile", icon: "user" },
];

export function SideNav({ pending, videos = 0 }: { pending: number; videos?: number }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="side-nav">
      {NAV.map((n) => {
        const on = n.href === "/" ? path === "/" : path.startsWith(n.href);
        return (
          <Link key={n.href} href={n.href} className={on ? "on" : ""} aria-current={on ? "page" : undefined}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
            {n.href === "/videos" && videos > 0 && <span className="nav-badge" aria-label={`${videos} videos to review`}>{videos}</span>}
            {n.href === "/credit-unions" && pending > 0 && <span className="nav-badge" aria-label={`${pending} statements waiting for you`}>{pending}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
