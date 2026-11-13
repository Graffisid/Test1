"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Refreshes the page every few seconds while something (a video render) is in progress. */
export function AutoRefresh({ active, every = 4000 }: { active: boolean; every?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), every);
    return () => clearInterval(t);
  }, [active, every, router]);
  return null;
}
