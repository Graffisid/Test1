"use client";

import { useActionState } from "react";
import { toggleConnectionAction, type ActionState } from "@/app/actions";
import { toast } from "./Toaster";

/** The owner's switch. Turning something off asks first: agents that need it stop straight away. */
export function ConnectionSwitch({ k, name, on, settable }: { k: string; name: string; on: boolean; settable: boolean }) {
  const [, action, pending] = useActionState<ActionState | null, FormData>(async (prev, form) => {
    const r = await toggleConnectionAction(prev, form);
    toast(r.ok, r.message);
    return r;
  }, null);
  return (
    <form action={action}
      onSubmit={(e) => { if (on && !window.confirm(`Switch off ${name}? Anything that needs it stops until you switch it back on.`)) e.preventDefault(); }}>
      <input type="hidden" name="key" value={k} />
      <input type="hidden" name="on" value={on ? "0" : "1"} />
      <button type="submit" role="switch" aria-checked={on} aria-label={`${name}: ${on ? "on" : "off"}`}
        className={`switch ${on ? "on" : ""} ${pending ? "busy" : ""}`} disabled={pending || !settable}
        title={settable ? `Switch ${on ? "off" : "on"}` : "Not set up yet"}>
        <span className="knob" />
      </button>
    </form>
  );
}
