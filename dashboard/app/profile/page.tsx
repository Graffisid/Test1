import { ActionForm } from "@/components/ActionForm";
import { requireOwnerPage } from "@/lib/session";
import { getSender, senderComplete } from "@/lib/oncu";
import { saveSenderAction } from "../sharing-actions";

export const dynamic = "force-dynamic";

export default async function Profile() {
  await requireOwnerPage();
  const s = await getSender();
  return (
    <>
      <header className="page-head rise">
        <div>
          <p className="eyebrow">Profile</p>
          <h1>Who the messages are <em>from</em></h1>
          <p className="page-sub">Every message to a credit union ends with these details. Canada&apos;s anti-spam law (CASL) requires the sender&apos;s name,
            a mailing address and a way to unsubscribe; the studio adds all three automatically.</p>
        </div>
        <span className={`pill ${senderComplete(s) ? "good" : "warn"}`}>{senderComplete(s) ? "Ready to send" : "Add your name and mailing address"}</span>
      </header>
      <section className="card rise narrow-card" aria-label="Sender details">
        <ActionForm action={saveSenderAction} className="offer-form">
          <label>Your name<input name="sender_name" defaultValue={s.sender_name} maxLength={100} required autoComplete="name" /></label>
          <label>Title <span className="muted small">(optional)</span><input name="title" defaultValue={s.title} maxLength={100} placeholder="Founder" /></label>
          <label>Organization<input name="organization" defaultValue={s.organization} maxLength={120} required /></label>
          <label>Reply-to email<input name="email" type="email" defaultValue={s.email} maxLength={200} required /></label>
          <label>Mailing address <span className="muted small">(required by CASL; a business address or PO box)</span>
            <textarea name="mailing_address" defaultValue={s.mailing_address} maxLength={300} rows={3} required /></label>
          <label>Website<input name="website" defaultValue={s.website} maxLength={200} required /></label>
          <div className="offer-foot"><span className="muted small">{s.updated_by ? `Last saved by ${s.updated_by}` : "Not saved yet"}</span>
            <button type="submit" className="btn small primary">Save</button></div>
        </ActionForm>
      </section>
    </>
  );
}
