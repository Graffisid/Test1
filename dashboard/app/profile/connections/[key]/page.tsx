import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/Icon";
import { CONNECTORS } from "@/lib/connectors";
import { requireOwnerPage } from "@/lib/session";
import { getIntegrations, getProfile } from "@/lib/queries";
import { connectAction } from "../../../profile-actions";

export const dynamic = "force-dynamic";

/** Practice sign-in: looks and behaves like the real consent screen, but nothing leaves this computer. */
export default async function Connect({ params }: { params: Promise<{ key: string }> }) {
  await requireOwnerPage();
  const { key } = await params;
  const info = CONNECTORS[key];
  const [items, { profile }] = await Promise.all([getIntegrations(), getProfile()]);
  const item = items.find((i) => i.key === key);
  if (!info || !item) notFound();
  return (
    <div className="consent-wrap rise">
      <Link href="/profile/connections" className="crumbs-link"><Icon name="arrowRight" className="flip" /> Back to connections</Link>
      <article className="consent" data-key={key}>
        <header className="consent-head">
          <span className="brand-tile big" data-key={key}>{info.provider.slice(0, 1)}</span>
          <span className="consent-arrow" aria-hidden="true">⇄</span>
          <span className="logo big" aria-hidden="true">N</span>
        </header>
        <p className="practice-badge">Practice sign-in · sandbox</p>
        <h1>{info.signIn}</h1>
        <p className="muted"><strong>Northshore Growth Desk</strong> wants to connect to your {info.provider} account{item.connected ? " (already connected — this replaces it)" : ""}.</p>
        <ActionForm action={connectAction} className="consent-form">
          <input type="hidden" name="key" value={key} />
          <label className="field"><span>{info.provider} account or page to connect</span>
            <input name="account" required maxLength={120} defaultValue={`${profile.business_name}`} /></label>
          <div className="consent-asks">
            <p><strong>It will be able to:</strong></p>
            <ul className="plain">{info.asks.map((a) => <li key={a}><Icon name="check" /> {a}</li>)}</ul>
            <p className="muted small"><strong>It will never:</strong> post, spend or message anyone without your OK, or see your {info.provider} password.</p>
          </div>
          <label className="confirm"><input type="checkbox" name="allow" value="yes" required /> I own this account and allow this access</label>
          <div className="actions">
            <button type="submit" className="btn primary consent-allow">Allow</button>
            <Link href="/profile/connections" className="btn ghost">Cancel</Link>
          </div>
        </ActionForm>
        <p className="consent-foot muted small"><Icon name="info" /> Real sign-in later: {info.real}. You can disconnect any time from Connections.</p>
      </article>
    </div>
  );
}
