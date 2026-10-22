"use client";

import { useActionState, useRef } from "react";
import type { ActionState } from "@/app/actions";
import { toast } from "./Toaster";

/** A form bound to a server action: shows the result as a toast and disables the submit button while saving. */
export function ActionForm({ action, children, className, resetOnSuccess, confirm }: {
  action: (prev: ActionState | null, form: FormData) => Promise<ActionState>;
  children: React.ReactNode; className?: string; resetOnSuccess?: boolean; confirm?: string;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [, run, pending] = useActionState<ActionState | null, FormData>(async (prev, form) => {
    const r = await action(prev, form);
    toast(r.ok, r.message);
    if (r.ok && resetOnSuccess) ref.current?.reset();
    return r;
  }, null);
  return (
    <form ref={ref} action={run} className={`${className ?? ""} ${pending ? "busy" : ""}`} aria-busy={pending}
      onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}>
      <fieldset disabled={pending} className="plain-fieldset">{children}</fieldset>
    </form>
  );
}
