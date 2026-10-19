import Link from "next/link";
import { Icon } from "./Icon";

export function ProfileTabs({ on }: { on: "profile" | "connections" }) {
  return (
    <nav className="filters" aria-label="Profile sections">
      <Link href="/profile" className={`filter ${on === "profile" ? "on" : ""}`} aria-current={on === "profile" ? "page" : undefined}><Icon name="user" /> Profile &amp; WhatsApp</Link>
      <Link href="/profile/connections" className={`filter ${on === "connections" ? "on" : ""}`} aria-current={on === "connections" ? "page" : undefined}><Icon name="plug" /> Connections</Link>
    </nav>
  );
}
