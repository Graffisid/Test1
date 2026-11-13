import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Icon } from "@/components/Icon";
import { textBody } from "@/lib/message";
import { requireOwnerPage } from "@/lib/session";
import { getContacts, getLessons, getSender, getShares, getVideos, senderComplete, type ShareRow } from "@/lib/oncu";
import { createShareAction, decideShareAction, outcomeAction, saveShareAction } from "../sharing-actions";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "flat" }, approved: { label: "Approved, writing to outbox…", tone: "accent" }, sent: { label: "In your outbox", tone: "good" },
  failed: { label: "Failed", tone: "bad" }, cancelled: { label: "Cancelled", tone: "flat" },
};
const OUTCOME: Record<string, string> = { replied: "Replied", meeting: "Meeting booked", not_interested: "Not interested", unsubscribed: "Unsubscribed" };
const fmtDate = (d: string) => new Date(d).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Toronto" });

function Btn({ action, share, name, value, label, primary }: { action: typeof decideShareAction; share: number; name: string; value: string; label: string; primary?: boolean }) {
  return (
    <ActionForm action={action}>
      <input type="hidden" name="share_id" value={share} /><input type="hidden" name={name} value={value} />
      <button type="submit" className={`btn small ${primary ? "primary" : "ghost"}`}>{label}</button>
    </ActionForm>
  );
}

export default async function Sharing() {
  await requireOwnerPage();
  const [shares, videos, contacts, lessons, sender] = await Promise.all([getShares(), getVideos(), getContacts(), getLessons(), getSender()]);
  const approvedVideos = videos.filter((v) => v.status === "approved");
  const published = lessons.filter((l) => l.status === "published");
  const lessonBy = new Map(lessons.map((l) => [l.key, l]));
  const contactBy = new Map(contacts.map((c) => [c.id, c]));
  const ready = senderComplete(sender);
  const preview = (s: ShareRow) => {
    const c = contactBy.get(s.contact_id)!;
    return textBody({ shareId: s.id, subject: s.subject, body: s.body, sender, contact: c, cuName: s.cu_short, date: new Date(),
      lessons: s.lesson_keys.map((k) => lessonBy.get(k)).filter((l) => l && l.status === "published") as never,
      video: { fileName: `trisanga-${s.cu_id}-story.mp4`, data: Buffer.alloc(0) } });
  };
  const sent = shares.filter((s) => s.status === "sent");
  return (
    <>
      <AutoRefresh active={shares.some((s) => s.status === "approved")} />
      <header className="page-head rise">
        <div>
          <p className="eyebrow">Collaboration</p>
          <h1>Share a story with a <em>credit union</em></h1>
          <p className="page-sub">Write to a contact about their credit union&apos;s approved video, with learning notes attached. You approve every message.
            In this build the mailer writes each approved message to your outbox as an email file; nothing is emailed yet.</p>
        </div>
        <span className="pill accent">{sent.length} sent · {sent.filter((s) => s.outcome === "replied" || s.outcome === "meeting").length} conversations</span>
      </header>

      {!ready && (
        <div className="card rise note-card"><Icon name="info" /><div><h2>Add your sender details first</h2>
          <p className="muted">CASL requires your name and a mailing address in every message. <Link href="/profile">Open Profile</Link></p></div></div>
      )}

      <section className="card rise" aria-labelledby="new-h">
        <header className="card-head"><div><p className="eyebrow">New message</p><h2 id="new-h">Start from an approved video</h2></div></header>
        {approvedVideos.length === 0 ? <p className="muted">No approved videos yet. <Link href="/videos">Review videos</Link></p> : (
          <ul className="plain start-list">
            {approvedVideos.map((v) => {
              const list = contacts.filter((c) => c.cu_id === v.cu_id && c.sendable);
              return (
                <li key={v.id} className="start-row">
                  <div><strong>{v.cu_name}</strong> <span className="muted small">· {v.format === "vertical" ? "vertical 9:16" : "wide 16:9"} video #{v.id}</span></div>
                  {list.length === 0 ? <Link href={`/credit-unions/${v.cu_id}#contacts-h`} className="btn small">Add a contact</Link> : (
                    <ActionForm action={createShareAction} className="map-form">
                      <input type="hidden" name="video_id" value={v.id} />
                      <select name="contact_id" aria-label={`Contact at ${v.cu_name}`}>{list.map((c) => <option key={c.id} value={c.id}>{c.full_name} · {c.role_title}</option>)}</select>
                      <button type="submit" className="btn small primary">Start draft</button>
                    </ActionForm>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {shares.length > 0 && (
        <div className="stack">
          {shares.map((s) => {
            const st = STATUS[s.status];
            return (
              <article key={s.id} className="card rise share-card">
                <header className="claim-head">
                  <div><p className="eyebrow"><Link href={`/credit-unions/${s.cu_id}`}>{s.cu_name}</Link></p>
                    <h3>To {s.contact_name} <span className="muted small">&lt;{s.contact_email}&gt;</span> · message #{s.id}</h3></div>
                  <div className="claim-actions">{s.outcome !== "none" && <span className="pill good">{OUTCOME[s.outcome]}</span>}<span className={`pill ${st.tone}`}>{st.label}</span></div>
                </header>
                {s.error && <p className="small bad-text">{s.error}</p>}
                {s.status === "draft" ? (
                  <ActionForm action={saveShareAction} className="offer-form">
                    <input type="hidden" name="share_id" value={s.id} />
                    <label>Subject<input name="subject" defaultValue={s.subject} maxLength={150} required /></label>
                    <label>Message<textarea name="body" defaultValue={s.body} maxLength={4000} rows={11} required /></label>
                    <fieldset className="lesson-picks"><legend>Learning notes to include <span className="muted small">(published only, up to 5)</span></legend>
                      {published.length === 0 && <p className="muted small">None published yet. <Link href="/learning">Open Learning</Link></p>}
                      {published.map((l) => <label key={l.key} className="check"><input type="checkbox" name="lesson" value={l.key} defaultChecked={s.lesson_keys.includes(l.key)} /> {l.title}</label>)}
                    </fieldset>
                    <div className="offer-foot"><span className="muted small">Save your edits before approving.</span><button type="submit" className="btn small">Save draft</button></div>
                  </ActionForm>
                ) : (
                  <p className="muted small">Subject: <strong>{s.subject}</strong>{s.approved_by ? ` · approved by ${s.approved_by}${s.approved_at ? ` on ${fmtDate(s.approved_at)}` : ""}` : ""}
                    {s.sent_at ? ` · written to outbox ${fmtDate(s.sent_at)}` : ""}</p>
                )}
                <details className="fact-group">
                  <summary><strong>Preview the email</strong> <span className="muted small">exactly as it will read, with the footer CASL requires</span></summary>
                  <pre className="mail-preview">{preview(s)}</pre>
                </details>
                <div className="claim-actions video-actions">
                  {(s.status === "draft" || s.status === "failed") && !s.unsubscribed && (
                    ready ? <Btn action={decideShareAction} share={s.id} name="decision" value="approve" label={s.status === "failed" ? "Try again" : "Approve and send to outbox"} primary />
                      : <Link href="/profile" className="btn small">Add sender details to approve</Link>)}
                  {["draft", "approved", "failed"].includes(s.status) && <Btn action={decideShareAction} share={s.id} name="decision" value="cancel" label="Cancel" />}
                  {s.status === "sent" && <a className="btn small" href={`/sharing/${s.id}/eml`} download><Icon name="arrowDown" /> Email file (.eml)</a>}
                  {s.status === "sent" && s.outcome === "none" && (["replied", "meeting", "not_interested", "unsubscribed"] as const).map((o) => (
                    <Btn key={o} action={outcomeAction} share={s.id} name="outcome" value={o} label={OUTCOME[o]} />
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
