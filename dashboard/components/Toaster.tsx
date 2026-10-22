"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";

interface Toast { id: number; ok: boolean; message: string; href?: string; cta?: string; bell?: boolean }
const EVENT = "desk:toast";

/** Shows a short confirmation after a decision. Cards unmount on success, so they report here instead. */
export function toast(ok: boolean, message: string, extra: { href?: string; cta?: string; bell?: boolean } = {}) {
  window.dispatchEvent(new CustomEvent<Omit<Toast, "id">>(EVENT, { detail: { ok, message, ...extra } }));
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    let n = 0;
    const on = (e: Event) => {
      const detail = (e as CustomEvent<Omit<Toast, "id">>).detail;
      const id = ++n;
      setItems((xs) => [...xs.slice(-2), { id, ...detail }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), detail.bell ? 12000 : 6000);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <p key={t.id} className={`toast ${t.ok ? "ok" : "err"} ${t.bell ? "bell" : ""}`}>
          <Icon name={t.bell ? "bell" : t.ok ? "check" : "info"} />
          <span>{t.message}{t.href && <> <a href={t.href}>{t.cta ?? "Open"}</a></>}</span>
        </p>
      ))}
    </div>
  );
}
