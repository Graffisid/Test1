"use client";

import { useActionState } from "react";
import { requestAgentAction, type ActionState } from "@/app/actions";
import { Icon, type IconName } from "./Icon";
import { toast } from "./Toaster";

/** Queues a request for the team. The dashboard can't run agents itself; the agent loop picks this up. */
export function StudioButton({ kind, label, icon, busy, primary }: { kind: "market_analysis" | "create_content"; label: string; icon: IconName; busy: boolean; primary?: boolean }) {
  const [, action, pending] = useActionState<ActionState | null, FormData>(async (prev, form) => {
    const r = await requestAgentAction(prev, form);
    toast(r.ok, r.message);
    return r;
  }, null);
  return (
    <form action={action}>
      <input type="hidden" name="kind" value={kind} />
      <button type="submit" className={`btn ${primary ? "primary" : ""}`} disabled={pending || busy}>
        <Icon name={icon} /> {pending || busy ? "Working…" : label}
      </button>
    </form>
  );
}
