"use client";

import { useActionState, useState } from "react";
import { approveAction, editAction, rejectAction, type ActionState } from "@/app/actions";
import { Icon, KIND_ICON } from "./Icon";
import { StatusChip } from "./StatusChip";
import { toast } from "./Toaster";
import { phonePretty } from "@/lib/format";

export interface ApprovalView {
  id: string;
  kind: string;
  kindLabel: string;
  ifApproved: string;
  title: string;
  summary: string | null;
  payload: Record<string, unknown>;
  original_payload: Record<string, unknown> | null;
  requestedBy: string;
  status: string;
  edited: boolean;
  needs_fact_check: boolean;
  createdLabel: string;
  expiresLabel: string;
  decidedLabel: string | null;
  decided_by: string | null;
  decision_note: string | null;
  leadId: string | null;
}

const FIELD_LABEL: Record<string, string> = {
  headline: "Headline",
  primary_text: "Main text",
  cta: "Button",
  voiceover_script: "Voiceover script",
  caption: "Caption",
  script: "Video script",
  draft_reply: "Your reply",
};
const EDITABLE: Record<string, string[]> = {
  ad_variant: ["headline", "primary_text", "cta", "voiceover_script"],
  organic_post: ["caption", "script"],
  reputation_reply: ["draft_reply"],
};
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Shows the item the way the public would see it: an ad as an ad, a reply as a reply. */
export function Preview({ kind, p, leadId }: { kind: string; p: Record<string, unknown>; leadId?: string | null }) {
  if (kind === "booking") {
    const src = (p.source ?? {}) as Record<string, unknown>;
    const at = (iso: unknown) => typeof iso === "string"
      ? new Date(iso).toLocaleString("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
    return (
      <div className="pv-booking">
        <div className="bk-when">
          <span className="bk-day">{str(p.slot_label)}</span>
          <span className="bk-what">{str(p.service)} · {str(p.price)}</span>
        </div>
        <dl className="bk-facts">
          <div><dt>Customer</dt><dd>{str(p.customer)}</dd></div>
          <div><dt>Phone</dt><dd>{phonePretty(str(p.phone))}</dd></div>
          <div><dt>Came from</dt><dd>{str(src.ad) ? <>{str(src.ad)}{str(src.variant) ? ` — variant ${str(src.variant)}` : ""}</> : "Unknown source"}</dd></div>
          {str(src.comment) && <div><dt>Their comment</dt><dd>“{str(src.comment)}”{at(src.commented_at) ? <span className="muted"> · {at(src.commented_at)}</span> : null}</dd></div>}
          <div><dt>Form &amp; consent</dt><dd>{at(p.form_at)} · {str(p.consent) ?? "recorded"}</dd></div>
        </dl>
        {leadId && <a className="bk-audit" href={`/customers/${leadId}`}>See the full audit trail →</a>}
      </div>
    );
  }
  if (kind === "budget_reallocation") {
    const proposals = Array.isArray(p.proposals) ? (p.proposals as string[]) : [];
    const projected = typeof p.weekly_projection_cad === "number" ? p.weekly_projection_cad : null;
    const cap = Number(p.weekly_cap_cad ?? 500);
    return (
      <div className="pv-budget">
        <ul className="plain changes">
          {proposals.map((x) => (
            <li key={x}>
              <Icon name={x.trim().startsWith("+") ? "arrowUp" : x.startsWith("hold") ? "minus" : "sliders"} />
              {x}
            </li>
          ))}
        </ul>
        {projected !== null && (
          <div className="cap">
            <div className="cap-row"><span>This week&apos;s projected spend</span><strong>${projected.toFixed(0)} of ${cap}</strong></div>
            <svg className="cap-bar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
              <rect className="cap-track" x="0" y="0" width="100" height="8" rx="4" />
              <rect className={`cap-fill ${projected > cap * 0.9 ? "hot" : ""}`} x="0" y="0" height="8" rx="4" width={Math.min(100, (projected / cap) * 100)} />
            </svg>
          </div>
        )}
      </div>
    );
  }
  if (kind === "reputation_reply") {
    return (
      <div className="pv-reply">
        {str(p.review) && <p className="bubble them">“{str(p.review)}”</p>}
        {str(p.draft_reply) && <p className="bubble us">{str(p.draft_reply)}</p>}
      </div>
    );
  }
  if (kind === "organic_post" && str(p.format)) {
    const scenes = Array.isArray(p.scenes) ? (p.scenes as { seconds: number; shot: string; on_screen_text: string; voiceover: string }[]) : [];
    const slides = Array.isArray(p.slides) ? (p.slides as { headline: string; body: string }[]) : [];
    const tags = Array.isArray(p.hashtags) ? (p.hashtags as string[]) : [];
    const at = str(p.scheduled_for) ? new Date(str(p.scheduled_for)!).toLocaleString("en-CA", { timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
    return (
      <div className="pv-post studio">
        <p className="pv-hook">“{str(p.hook)}”</p>
        {scenes.length > 0 && (
          <ol className="plain storyboard">
            {scenes.map((s, i) => (
              <li key={i}><span className="sb-sec">{s.seconds}s</span><div><strong>{s.on_screen_text || "—"}</strong>
                <p className="muted small">{s.shot}</p>{s.voiceover && <p className="small">🎙 {s.voiceover}</p>}</div></li>
            ))}
          </ol>
        )}
        {slides.length > 0 && (
          <ol className="plain slides">
            {slides.map((s, i) => <li key={i}><strong>{s.headline}</strong><p className="small">{s.body}</p></li>)}
          </ol>
        )}
        {!scenes.length && !slides.length && str(p.visual_brief) && <p className="small muted">Picture: {str(p.visual_brief)}</p>}
        <p>{str(p.caption)}</p>
        {tags.length > 0 && <p className="pv-tags">{tags.join(" ")}</p>}
        <p className="pv-meta">{[str(p.format)?.replace("_", " "), str(p.platform), at].filter(Boolean).join(" · ")}</p>
      </div>
    );
  }
  if (kind === "organic_post") {
    return (
      <div className="pv-post">
        {str(p.caption) && <p>{str(p.caption)}</p>}
        {str(p.script) && <p>{str(p.script)}</p>}
        <p className="pv-meta">
          {[str(p.channel)?.replace("_", " "), str(p.scheduled_for)].filter(Boolean).join(" · ")}
        </p>
      </div>
    );
  }
  return (
    <div className="pv-ad">
      <div className="pv-ad-head">
        <span className="pv-logo" aria-hidden="true">N</span>
        <span><strong>Northshore Plumbing &amp; Heating</strong><span className="pv-sponsored">Sponsored</span></span>
      </div>
      {str(p.primary_text) && <p className="pv-text">{str(p.primary_text)}</p>}
      <div className="pv-media" aria-hidden="true"><Icon name="play" /></div>
      <div className="pv-ad-foot">
        <strong>{str(p.headline)}</strong>
        {str(p.cta) && <span className="pv-cta">{str(p.cta)}</span>}
      </div>
      {str(p.voiceover_script) && (
        <details className="pv-more">
          <summary>Voiceover script</summary>
          <p>{str(p.voiceover_script)}</p>
        </details>
      )}
    </div>
  );
}

export function ApprovalCard({ a }: { a: ApprovalView }) {
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  // Each action reports through a toast: on success the card leaves the queue straight away.
  const report = (fn: typeof approveAction) => async (prev: ActionState | null, form: FormData) => {
    const r = await fn(prev, form);
    toast(r.ok, r.message);
    return r;
  };
  const [, approve, approving] = useActionState<ActionState | null, FormData>(report(approveAction), null);
  const [, reject, rejecting] = useActionState<ActionState | null, FormData>(report(rejectAction), null);
  const [, edit, saving] = useActionState<ActionState | null, FormData>(async (prev, form) => {
    const r = await report(editAction)(prev, form);
    if (r.ok) setMode("view");
    return r;
  }, null);
  const busy = approving || rejecting || saving;
  const pending = a.status === "pending";
  const editable = a.payload.format ? undefined : EDITABLE[a.kind];

  return (
    <article className={`approval ${a.needs_fact_check ? "flagged" : ""} ${busy ? "busy" : ""}`} aria-busy={busy}>
      <header className="approval-head">
        <span className={`kind-icon k-${a.kind}`}><Icon name={KIND_ICON[a.kind] ?? "sparkle"} /></span>
        <div className="approval-titles">
          <span className="kind">{a.kindLabel}{a.edited && <> · edited by you</>}</span>
          <h3>{a.title}</h3>
        </div>
        {pending ? (
          <span className="expires" title="Items you don't decide on expire. Nothing is ever approved by silence.">
            <Icon name="clock" /> {a.expiresLabel.replace("in ", "")} left
          </span>
        ) : <StatusChip status={a.status} />}
      </header>

      {a.summary && <p className="approval-summary">{a.summary}</p>}

      {a.needs_fact_check && pending && (
        <p className="factcheck"><Icon name="flag" /> Check this first: it makes a claim that isn&apos;t in your verified facts.</p>
      )}

      {mode === "edit" && editable ? (
        <form action={edit} className="edit-form">
          <input type="hidden" name="id" value={a.id} />
          {editable.filter((k) => typeof a.payload[k] === "string").map((k) => (
            <label key={k} className="field">
              <span>{FIELD_LABEL[k] ?? k}</span>
              {k === "headline" || k === "cta" ? (
                <input name={k} defaultValue={String(a.payload[k])} required />
              ) : (
                <textarea name={k} defaultValue={String(a.payload[k])} rows={3} required />
              )}
            </label>
          ))}
          <p className="hint">Saving keeps it waiting. It still needs your Approve.</p>
          <div className="actions">
            <button type="submit" className="btn primary" disabled={busy}>{saving ? "Saving…" : "Save changes"}</button>
            <button type="button" className="btn ghost" onClick={() => setMode("view")} disabled={busy}>Cancel</button>
          </div>
        </form>
      ) : (
        <Preview kind={a.kind} p={a.payload} leadId={a.leadId} />
      )}

      {a.edited && a.original_payload && mode === "view" && (
        <details className="pv-more">
          <summary>Show what the {a.requestedBy.toLowerCase()} first wrote</summary>
          <Preview kind={a.kind} p={a.original_payload} />
        </details>
      )}

      {pending && mode === "view" && (
        <>
          <p className="if-approved"><Icon name="sparkle" /> <span><strong>If you approve:</strong> {a.ifApproved}</span></p>
          <form action={approve} className="actions">
            <input type="hidden" name="id" value={a.id} />
            {a.needs_fact_check && (
              <label className="confirm">
                <input type="checkbox" name="factChecked" required /> I&apos;ve checked this claim is true
              </label>
            )}
            <button type="submit" className="btn primary" disabled={busy}>
              <Icon name="check" /> {approving ? "Saving…" : a.kind === "booking" ? "Confirm booking" : "Approve"}
            </button>
            {editable && (
              <button type="button" className="btn" onClick={() => setMode("edit")} disabled={busy}>
                <Icon name="pencil" /> Edit
              </button>
            )}
            <button type="button" className="btn ghost danger" onClick={() => setMode("reject")} disabled={busy}>
              <Icon name="x" /> Decline
            </button>
          </form>
        </>
      )}

      {pending && mode === "reject" && (
        <form action={reject} className="edit-form">
          <input type="hidden" name="id" value={a.id} />
          <label className="field">
            <span>{a.kind === "booking" ? "Why? (optional, for your records)" : "Tell your team why (optional, it helps them learn)"}</span>
            <textarea name="note" rows={2} maxLength={500} autoFocus />
          </label>
          <div className="actions">
            <button type="submit" className="btn danger-solid" disabled={busy}>{rejecting ? "Declining…" : "Decline"}</button>
            <button type="button" className="btn ghost" onClick={() => setMode("view")} disabled={busy}>Cancel</button>
          </div>
        </form>
      )}

      <p className="meta">
        Prepared by {a.requestedBy} · {a.createdLabel}
        {!pending && a.decided_by ? <> · decided by {a.decided_by}, {a.decidedLabel}</> : null}
      </p>
      {!pending && a.decision_note && <p className="meta">“{a.decision_note}”</p>}
    </article>
  );
}
