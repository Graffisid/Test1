import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/Icon";
import { ProfileTabs } from "@/components/ProfileTabs";
import { requireOwnerPage } from "@/lib/session";
import { dateTime, phonePretty } from "@/lib/format";
import { getProfile } from "@/lib/queries";
import { confirmWhatsAppChangeAction, requestWhatsAppChangeAction, saveProfileAction, setAutoSendAction } from "../profile-actions";

export const dynamic = "force-dynamic";

export default async function Profile() {
  await requireOwnerPage();
  const { profile: p, whatsapp, pendingChange } = await getProfile();
  const initials = p.display_name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return (
    <>
      <header className="page-head rise">
        <div className="member-title">
          <span className="avatar big" aria-hidden="true">{initials}</span>
          <div><p className="eyebrow">Your profile</p><h1>{p.display_name}</h1><p className="page-sub">Owner · {p.business_name}{p.city ? ` · ${p.city}` : ""}</p></div>
        </div>
      </header>
      <ProfileTabs on="profile" />

      <div className="grid-2 wide-left">
        <section className="card rise" aria-labelledby="me-title">
          <header className="card-head"><div><p className="eyebrow">Details</p><h2 id="me-title">You and your business</h2></div>
            <span className="muted small">Last saved {dateTime(p.updated_at)}</span></header>
          <ActionForm action={saveProfileAction} className="form-grid">
            <h3 className="sub span-2">You</h3>
            <label className="field"><span>Your name</span><input name="display_name" defaultValue={p.display_name} maxLength={80} required autoComplete="name" /></label>
            <label className="field"><span>Email</span><input name="email" type="email" defaultValue={p.email ?? ""} maxLength={120} autoComplete="email" /></label>
            <label className="field"><span>Phone</span><input name="phone" type="tel" defaultValue={phonePretty(p.phone_e164) ?? ""} maxLength={30} autoComplete="tel" /></label>
            <h3 className="sub span-2">Your business</h3>
            <label className="field"><span>Business name</span><input name="business_name" defaultValue={p.business_name} maxLength={120} required /></label>
            <label className="field"><span>Website</span><input name="website" type="url" defaultValue={p.website ?? ""} maxLength={200} placeholder="https://" /></label>
            <label className="field span-2"><span>Address</span><input name="address" defaultValue={p.address ?? ""} maxLength={200} autoComplete="street-address" /></label>
            <label className="field"><span>City</span><input name="city" defaultValue={p.city ?? ""} maxLength={80} /></label>
            <label className="field"><span>Hours</span><input name="hours" defaultValue={p.hours ?? ""} maxLength={200} /></label>
            <label className="field span-2"><span>Areas you serve</span><input name="service_area" defaultValue={p.service_area ?? ""} maxLength={300} /></label>
            <div className="actions span-2"><button type="submit" className="btn primary"><Icon name="check" /> Save changes</button></div>
          </ActionForm>
        </section>

        <div className="stack">
          <section className="card rise" aria-labelledby="wa-title">
            <header className="card-head"><div><p className="eyebrow">Approvals on your phone</p><h2 id="wa-title">WhatsApp</h2></div>
              <span className={`pill ${whatsapp.on && whatsapp.number ? "good" : "warn"}`}>{whatsapp.on && whatsapp.number ? "Ready" : whatsapp.number ? "Switched off" : "No number"}</span></header>
            <p className="wa-number"><span className="wa-icon" aria-hidden="true"><Icon name="chat" /></span>
              <span><strong>{whatsapp.number ?? "No number yet"}</strong><span className="muted small">Only replies from this number can approve anything.</span></span></p>
            <ActionForm action={setAutoSendAction} className="toggle-row">
              <input type="hidden" name="on" value={whatsapp.auto ? "0" : "1"} />
              <span><strong>Send everything automatically</strong><span className="muted small">{whatsapp.auto ? "Every post, ad, reply and booking goes to WhatsApp as soon as it's ready." : "Only items you send with “Send to my WhatsApp”."}</span></span>
              <button type="submit" role="switch" aria-checked={whatsapp.auto} aria-label="Send everything to WhatsApp automatically" className={`switch ${whatsapp.auto ? "on" : ""}`} disabled={!whatsapp.number}><span className="knob" /></button>
            </ActionForm>

            <details className="change-number" open={!!pendingChange}>
              <summary>Change number</summary>
              {!pendingChange ? (
                <ActionForm action={requestWhatsAppChangeAction} className="form-grid one" resetOnSuccess>
                  <label className="field"><span>New WhatsApp number</span><input name="number" type="tel" required maxLength={30} placeholder="905 555 0123" autoComplete="tel" /></label>
                  <label className="field"><span>Your dashboard password (to confirm it's you)</span><input name="password" type="password" required maxLength={256} autoComplete="current-password" /></label>
                  <p className="hint">We send a 6-digit code to the new number on WhatsApp. Approvals move only after you enter it — so nobody can redirect them to another phone.</p>
                  <div className="actions"><button type="submit" className="btn">Send code to new number</button></div>
                </ActionForm>
              ) : (
                <ActionForm action={confirmWhatsAppChangeAction} className="form-grid one" resetOnSuccess>
                  <p>{pendingChange.sent ? <>Code sent to <strong>{pendingChange.masked}</strong>.</> : <>Sending a code to <strong>{pendingChange.masked}</strong>…</>} It expires {dateTime(pendingChange.expires_at)}.</p>
                  <label className="field"><span>6-digit code from WhatsApp</span><input name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" required maxLength={7} autoComplete="one-time-code" /></label>
                  <div className="actions"><button type="submit" className="btn primary">Verify and switch</button></div>
                </ActionForm>
              )}
            </details>
          </section>

          <section className="card rise" aria-labelledby="sec-title">
            <header className="card-head"><div><p className="eyebrow">Security</p><h2 id="sec-title">Sign-in</h2></div></header>
            <ul className="plain rules-list">
              <li><Icon name="shield" /> Your dashboard password is set when the app starts, never stored in the database.</li>
              <li><Icon name="clock" /> Sessions end after 12 hours. 5 wrong passwords lock sign-in for 15 minutes.</li>
              <li><Icon name="check" /> Nothing posts, spends or books without your yes — here or on WhatsApp.</li>
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}
