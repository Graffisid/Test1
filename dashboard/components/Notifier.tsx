"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "./Toaster";

/** Rings when something new needs the owner (e.g. a customer just picked a time), and refreshes the page. */
export function Notifier() {
  const router = useRouter();
  const since = useRef(new Date().toISOString());
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/notifications?since=${encodeURIComponent(since.current)}`, { cache: "no-store" });
        if (!res.ok) return;
        const items: { id: string; kind: string; title: string; created_at: string }[] = await res.json();
        if (stop || !items.length) return;
        since.current = new Date(items.at(-1)!.created_at).toISOString();
        for (const a of items) {
          toast(true, a.kind === "booking" ? `New booking: ${a.title}` : `New item needs your OK: ${a.title}`,
            { bell: true, href: "/#approvals", cta: "Review" });
        }
        router.refresh();
      } catch { /* offline for a moment: try again next tick */ }
    };
    const t = setInterval(tick, 4000);
    return () => { stop = true; clearInterval(t); };
  }, [router]);
  return null;
}
