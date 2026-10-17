"use client";

import { useActionState, useState } from "react";
import { approveAction, editAction, rejectAction, type ActionState } from "@/app/actions";
import { StatusChip } from "./StatusChip";

export interface ApprovalView {
  id: string;
  kind: string;
  kindLabel: string;
  title: string;
  summary: string | null;
  payload: Record<string, unknown>;
  original_payload: Record<string, unknown> | null;
  requested_by_agent: string;
  status: string;
  edited: boolean;
  needs_fact_check: boolean;
  createdLabel: string;
  expiresLabel: string;
  decidedLabel: string | null;
  decided_by: string | null;
  decision_note: string | null;
  ad_name: string | null;
}

const FIELD_LABEL: Record<string, string> = {
  headline: "Headline",
  primary_text: "Primary text",
  cta: "Call to action",
  voiceover_script: "Voiceover script",
  caption: "Caption",
  script: "Script",
  draft_reply: "Draft reply",
  review: "Review",
};
const EDITABLE: Record<string, string[]> = {
  ad_variant: ["headline", "primary_text", "cta", "voiceover_script"],
  organic_post: ["caption", "script"],
  reputation_reply: ["draft_reply"],
};

function Preview({ a }: { a: ApprovalView }) {
  const p = a.payload;
  const field = (k: string) =>
    typeof p[k] === "string" ? (
      <div key={k} className="field">
        <dt>{FIELD_LABEL[k] ?? k}</dt>
        <dd className={k === "headline" ? "headline" : undefined}>{String(p[k])}</dd>
      </div>
    ) : null;

  if (a.kind === "budget_reallocation") {
    const proposals = Array.isArray(p.proposals) ? (p.proposals as string[]) : [];
    return (
      <dl className="preview">
        {proposals.length > 0 && (
          <div className="field">
            <dt>Proposed changes</dt>
            <dd><ul className="plain">{proposals.map((x) => <li key={x}>{x}</li>)}</ul></dd>
          </div>
        )}
        {typeof p.weekly_projection_cad === "number" && (
          <div className="field">
            <dt>Spend cap check</dt>
            <dd>Projected ${Number(p.weekly_projection_cad).toFixed(0)} this week vs ${String(p.weekly_cap_cad ?? 500)} cap</dd>
          </div>
        )}
      </dl>
    );
  }
  const keys = a.kind === "reputation_reply" ? ["review", "draft_reply"]
    : a.kind === "organic_post" ? ["caption", "script"] : ["headline", "primary_text", "cta", "voiceover_script"];
  const extra = a.kind === "organic_post"
    ? [p.channel && `Channel: ${String(p.channel).replace("_", " ")}`, p.scheduled_for && `Scheduled: ${String(p.scheduled_for)}`].filter(Boolean)
    : [];
  return (
    <dl className="preview">
      {keys.map(field)}
      {extra.length > 0 && <p className="muted small">{extra.join(" · ")}</p>}
      {typeof p.rubric_source === "string" && <p className="muted small">Learned from: {p.rubric_source}</p>}
    </dl>
  );
}

export function ApprovalCard({ a }: { a: ApprovalView }) {
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [approveState, approve, approving] = useActionState<ActionState | null, FormData>(approveAction, null);
  const [rejectState, reject, rejecting] = useActionState<ActionState | null, FormData>(rejectAction, null);
  const [editState, edit, saving] = useActionState<ActionState | null, FormData>(async (prev, form) => {
    const r = await editAction(prev, form);
    if (r.ok) setMode("view");
    return r;
  }, null);
  const state = [approveState, rejectState, editState].filter(Boolean).at(-1) ?? null;
  const busy = approving || rejecting || saving;
  const pending = a.status === "pending";
  const editable = EDITABLE[a.kind];

  return (
    <article className={`card approval ${a.needs_fact_check ? "flagged" : ""}`} aria-busy={busy}>
      <header className="approval-head">
        <span className="kind">{a.kindLabel}</span>
        {a.edited && <span className="chip chip-neutral">✎ Edited by you</span>}
        {a.needs_fact_check && <span className="chip chip-serious"><span aria-hidden="true">⚑</span> Unverified claim</span>}
        {!pending && <StatusChip status={a.status} />}
      </header>
      <h3 className="approval-title">{a.title}</h3>
      {a.summary && <p className="approval-summary">{a.summary}</p>}

      {mode === "edit" && editable ? (
        <form action={edit} className="edit-form">
          <input type="hidden" name="id" value={a.id} />
          {editable.filter((k) => typeof a.payload[k] === "string").map((k) => (
            <label key={k} className="edit-field">
              <span>{FIELD_LABEL[k] ?? k}</span>
              {k === "headline" || k === "cta" ? (
                <input name={k} defaultValue={String(a.payload[k])} required />
              ) : (
                <textarea name={k} defaultValue={String(a.payload[k])} rows={3} required />
              )}
            </label>
          ))}
          <div className="actions">
            <button type="submit" className="btn primary" disabled={busy}>{saving ? "Saving…" : "Save changes"}</button>
            <button type="button" className="btn ghost" onClick={() => setMode("view")} disabled={busy}>Cancel</button>
          </div>
          <p className="muted small">Saving keeps it pending. It still needs your Approve.</p>
        </form>
      ) : (
        <Preview a={a} />
      )}

      {a.edited && a.original_payload && mode === "view" && (
        <details className="original">
          <summary>Show the agent&apos;s original</summary>
          <Preview a={{ ...a, payload: a.original_payload }} />
        </details>
      )}

      <p className="meta">
        From <strong>{a.requested_by_agent}</strong> · {a.createdLabel}
        {pending ? <> · <span title="Pending items expire — they are never approved by silence">expires {a.expiresLabel}</span></> : null}
        {!pending && a.decided_by ? <> · {a.decided_by}, {a.decidedLabel}</> : null}
      </p>
      {!pending && a.decision_note && <p className="muted small">“{a.decision_note}”</p>}

      {pending && mode === "view" && (
        <form action={approve} className="actions">
          <input type="hidden" name="id" value={a.id} />
          {a.needs_fact_check && (
            <label className="confirm">
              <input type="checkbox" name="factChecked" required /> I&apos;ve verified this claim is true
            </label>
          )}
          <button type="submit" className="btn primary" disabled={busy}>{approving ? "Approving…" : "✓ Approve"}</button>
          {editable && <button type="button" className="btn" onClick={() => setMode("edit")} disabled={busy}>✎ Edit</button>}
          <button type="button" className="btn danger" onClick={() => setMode("reject")} disabled={busy}>✕ Reject</button>
        </form>
      )}

      {pending && mode === "reject" && (
        <form action={reject} className="reject-form">
          <input type="hidden" name="id" value={a.id} />
          <label className="edit-field">
            <span>Why? (optional — the agent learns from this)</span>
            <textarea name="note" rows={2} maxLength={500} />
          </label>
          <div className="actions">
            <button type="submit" className="btn danger" disabled={busy}>{rejecting ? "Rejecting…" : "Confirm reject"}</button>
            <button type="button" className="btn ghost" onClick={() => setMode("view")} disabled={busy}>Cancel</button>
          </div>
        </form>
      )}

      {state && (
        <p className={`notice ${state.ok ? "ok" : "err"}`} role="status">
          <span aria-hidden="true">{state.ok ? "✓" : "!"}</span> {state.message}
        </p>
      )}
    </article>
  );
}
