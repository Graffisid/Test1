"use client";

import { useActionState, useState } from "react";
import { approveAction, editAction, rejectAction, sendToWhatsAppAction, type ActionState } from "@/app/actions";
import { Preview } from "@/components/ApprovalCard";
import { Icon, KIND_ICON } from "@/components/Icon";
import { toast } from "@/components/Toaster";
import { ReviewReplyPreview, SocialPreview, type PostView } from "./SocialPreview";

export interface ReviewView {
  id: string; kind: string; kindLabel: string; ifApproved: string; title: string; summary: string | null;
  requestedBy: string; createdLabel: string; expiresLabel: string; leadId: string | null;
  needsFactCheck: boolean; flag: string | null;
  post: PostView | null;
  review: { review: string; reply: string; stars: number } | null;
  payload: Record<string, unknown>;
  checks: { name: string; ok: boolean; detail: string }[] | null;
  score: number | null;
  /** Toronto local "YYYY-MM-DDTHH:MM" for the date-time picker, when this item can be scheduled. */
  scheduleLocal: string | null;
  scheduleMin: string; scheduleMax: string;
  wa: { phoneOk: boolean; sentLabel: string | null; requested: boolean; reason: string | null };
  editable: { key: string; label: string; value: string; long: boolean }[];
}

/** One item to review: the post exactly as people will see it on the left, your decision on the right. */
export function ReviewCard({ a }: { a: ReviewView }) {
  const [mode, setMode] = useState<"view" | "reject" | "edit">("view");
  const run = (fn: typeof approveAction) => async (prev: ActionState | null, form: FormData) => {
    const r = await fn(prev, form);
    toast(r.ok, r.message);
    return r;
  };
  const [, approve, approving] = useActionState<ActionState | null, FormData>(run(approveAction), null);
  const [, reject, rejecting] = useActionState<ActionState | null, FormData>(run(rejectAction), null);
  const [, sendWa, sending] = useActionState<ActionState | null, FormData>(run(sendToWhatsAppAction), null);
  const [, edit, saving] = useActionState<ActionState | null, FormData>(async (prev, form) => {
    const r = await run(editAction)(prev, form);
    if (r.ok) setMode("view");
    return r;
  }, null);
  const busy = approving || rejecting || sending || saving;
  const visual = a.post || a.review;

  return (
    <article className={`review ${visual ? "" : "no-visual"} ${busy ? "busy" : ""}`} aria-busy={busy} id={`r-${a.id}`}>
      {visual && (
        <div className="review-visual">
          {a.post && <SocialPreview v={a.post} />}
          {a.review && <ReviewReplyPreview {...a.review} />}
        </div>
      )}
      <div className="review-body">
        <header className="review-head">
          <span className={`kind-icon k-${a.kind}`}><Icon name={KIND_ICON[a.kind] ?? "sparkle"} /></span>
          <div>
            <span className="kind">{a.kindLabel} · from {a.requestedBy} · {a.createdLabel}</span>
            <h2>{a.title}</h2>
          </div>
          <span className="expires" title="Items you don't decide on expire. Nothing is ever approved by silence."><Icon name="clock" /> {a.expiresLabel.replace("in ", "")} left</span>
        </header>

        {a.summary && <p className="review-why">{a.summary}</p>}
        {(a.needsFactCheck || a.flag) && <p className="factcheck"><Icon name="flag" /> {a.flag ?? "Check this first: it makes a claim that isn't in your verified facts."}</p>}

        {!a.post && !a.review && <Preview kind={a.kind} p={a.payload} leadId={a.leadId} />}

        {a.checks && (
          <details className="review-checks">
            <summary><Icon name="shield" /> {a.checks.filter((c) => c.ok).length}/{a.checks.length} safety checks passed{a.score !== null ? ` · analyst score ${a.score}/10` : ""}</summary>
            <ul className="plain">{a.checks.map((c) => <li key={c.name} className={c.ok ? "ok" : "bad"}><Icon name={c.ok ? "check" : "x"} /> <strong>{c.name}</strong> — {c.detail}</li>)}</ul>
          </details>
        )}

        {mode === "edit" && (
          <form action={edit} className="edit-form">
            <input type="hidden" name="id" value={a.id} />
            {a.editable.map((f) => (
              <label key={f.key} className="field"><span>{f.label}</span>
                {f.long ? <textarea name={f.key} defaultValue={f.value} rows={3} required /> : <input name={f.key} defaultValue={f.value} required />}
              </label>
            ))}
            <p className="hint">Saving keeps it waiting. It still needs your Approve.</p>
            <div className="actions">
              <button type="submit" className="btn primary" disabled={busy}>{saving ? "Saving…" : "Save changes"}</button>
              <button type="button" className="btn ghost" onClick={() => setMode("view")}>Cancel</button>
            </div>
          </form>
        )}

        {mode === "view" && (
          <form action={approve} className="decide">
            <input type="hidden" name="id" value={a.id} />
            {a.scheduleLocal !== null && (
              <label className="field schedule">
                <span><Icon name="calendar" /> Post on (Toronto time)</span>
                <input type="datetime-local" name="scheduled_for" defaultValue={a.scheduleLocal} min={a.scheduleMin} max={a.scheduleMax} />
              </label>
            )}
            <label className="field">
              <span>Comment for your team (optional)</span>
              <textarea name="note" rows={2} maxLength={500} placeholder={a.kind === "booking" ? "Anything to remember for this visit" : "What you like or want changed next time"} />
            </label>
            {a.needsFactCheck && <label className="confirm"><input type="checkbox" name="factChecked" required /> I&apos;ve checked this claim is true</label>}
            <p className="if-approved"><Icon name="sparkle" /> <span><strong>If you approve:</strong> {a.ifApproved}</span></p>
            <div className="actions">
              <button type="submit" className="btn primary" disabled={busy}><Icon name="check" /> {approving ? "Saving…" : a.kind === "booking" ? "Confirm booking" : a.scheduleLocal !== null ? "Approve & schedule" : "Approve"}</button>
              <button type="button" className="btn ghost danger" onClick={() => setMode("reject")} disabled={busy}><Icon name="x" /> Decline</button>
              {a.editable.length > 0 && <button type="button" className="btn ghost" onClick={() => setMode("edit")} disabled={busy}><Icon name="pencil" /> Edit text</button>}
            </div>
          </form>
        )}

        {mode === "reject" && (
          <form action={reject} className="decide">
            <input type="hidden" name="id" value={a.id} />
            <label className="field"><span>{a.kind === "booking" ? "Why? (optional, for your records)" : "Tell your team why (optional, it helps them learn)"}</span>
              <textarea name="note" rows={2} maxLength={500} autoFocus /></label>
            <div className="actions">
              <button type="submit" className="btn danger-solid" disabled={busy}>{rejecting ? "Declining…" : "Decline"}</button>
              <button type="button" className="btn ghost" onClick={() => setMode("view")}>Cancel</button>
            </div>
          </form>
        )}

        <div className="wa-row">
          <span className="wa-icon" aria-hidden="true"><Icon name="chat" /></span>
          {a.wa.sentLabel ? (
            <span><strong>On your WhatsApp</strong> since {a.wa.sentLabel}. Reply APPROVE or REJECT with the code there.</span>
          ) : a.wa.reason ? (
            <span className="muted">{a.wa.reason}</span>
          ) : a.wa.requested ? (
            <span><strong>Sending to your WhatsApp…</strong></span>
          ) : (
            <form action={sendWa} className="wa-send">
              <input type="hidden" name="id" value={a.id} />
              <span>Review it on your phone instead?</span>
              <button type="submit" className="btn small wa-btn" disabled={busy || !a.wa.phoneOk}>{sending ? "Sending…" : "Send to my WhatsApp"}</button>
            </form>
          )}
        </div>
      </div>
    </article>
  );
}
