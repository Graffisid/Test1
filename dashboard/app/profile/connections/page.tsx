import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { ConnectionSwitch } from "@/components/ConnectionSwitch";
import { Icon } from "@/components/Icon";
import { ProfileTabs } from "@/components/ProfileTabs";
import { CONNECTORS } from "@/lib/connectors";
import { dateTime } from "@/lib/format";
import { requireOwnerPage } from "@/lib/session";
import { getIntegrations, getNextAdCycle, getSchedule } from "@/lib/queries";
import { disconnectAction } from "../../profile-actions";

export const dynamic = "force-dynamic";

const GROUPS: { title: string; cats: string[] }[] = [
  { title: "Social media", cats: ["social", "research"] },
  { title: "Phone, messages & alerts", cats: ["phone", "voice", "alerts"] },
  { title: "Calendar & jobs", cats: ["calendar", "workspace"] },
  { title: "AI & media", cats: ["ai", "media"] },
];

export default async function ConnectionsPortal() {
  await requireOwnerPage();
  const [items, schedule, nextCycle] = await Promise.all([getIntegrations(), getSchedule(), getNextAdCycle()]);
  const connected = items.filter((i) => i.connected).length, on = items.filter((i) => i.enabled).length;
  return (
    <>
      <header className="page-head rise">
        <div><p className="eyebrow">Your profile</p><h1>Connections</h1>
          <p className="page-sub"><strong>{connected} of {items.length}</strong> services connected, <strong>{on}</strong> switched on. Connect a service once, then switch it on or off
            any time — when it's off, the database refuses anything that needs it, for every agent. Disconnect to remove the account completely.</p></div>
      </header>
      <ProfileTabs on="connections" />
      <p className="notice rise"><Icon name="info" /> Sandbox: “Connect” opens a practice sign-in. Real sign-in is switched on one service at a time once each app is registered with that company — nothing here asks for or stores your passwords.</p>

      {GROUPS.map((g) => {
        const list = items.filter((i) => g.cats.includes(i.category));
        if (!list.length) return null;
        return (
          <section key={g.title} className="rise" aria-label={g.title}>
            <h2 className="group-title">{g.title}</h2>
            <div className="conn-grid">
              {list.map((c) => {
                const info = CONNECTORS[c.key];
                return (
                  <article key={c.key} className={`conn2 ${c.connected ? "" : "disconnected"} ${c.enabled ? "is-on" : ""}`}>
                    <header className="conn-head">
                      <span className="brand-tile" data-key={c.key}>{(info?.provider ?? c.name).slice(0, 1)}</span>
                      <div className="conn-titles"><h3>{c.name}</h3>
                        <span className={`pill ${c.enabled ? "good" : c.connected ? "flat" : "warn"}`}>{c.enabled ? "On" : c.connected ? "Connected · off" : "Not connected"}</span></div>
                      {c.connected && <ConnectionSwitch k={c.key} name={c.name} on={c.enabled} settable={true} />}
                    </header>
                    <p className="conn-purpose">{c.purpose}</p>
                    {c.connected ? (
                      <p className="conn-meta"><Icon name="user" /> {c.account_label}{c.connected_at ? <span className="muted"> · since {dateTime(c.connected_at)}</span> : null}</p>
                    ) : <p className="conn-meta muted"><Icon name="info" /> When not connected: {c.when_off}</p>}
                    <p className="conn-meta"><Icon name="users" /> Used by {c.used_by}</p>
                    <div className="conn-actions">
                      {c.connected ? (
                        <ActionForm action={disconnectAction} confirm={`Disconnect ${c.name}? Agents lose access straight away.`}>
                          <input type="hidden" name="key" value={c.key} />
                          <button type="submit" className="btn small ghost danger"><Icon name="x" /> Disconnect</button>
                        </ActionForm>
                      ) : (
                        <Link className="btn small primary" href={`/profile/connections/${c.key}`}><Icon name="plug" /> Connect</Link>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}

      <div className="grid-2">
        <section className="card rise" aria-labelledby="sched-title">
          <header className="card-head"><h2 id="sched-title">Coming up</h2></header>
          {schedule.length === 0 && <p className="muted">Nothing scheduled yet.</p>}
          <ol className="plain sched">
            {schedule.map((s, i) => (
              <li key={i} className={`sched-${s.kind}`}>
                <span className="sched-when">{s.at ? dateTime(s.at) : s.kind === "publish" ? "Next run" : "Not yet"}</span>
                <div><strong>{s.href ? <Link href={s.href}>{s.title}</Link> : s.title}</strong><p className="muted small">{s.detail}</p></div>
              </li>
            ))}
          </ol>
        </section>
        <section className="card rise" aria-labelledby="routine-title">
          <header className="card-head"><h2 id="routine-title">Automatic routines</h2></header>
          <ul className="plain rules-list">
            <li><Icon name="inbox" /> Read and sort new comments, messages and forms — every few seconds</li>
            <li><Icon name="phone" /> Call back or text new leads — within a minute</li>
            <li><Icon name="megaphone" /> Publish approved posts — at the time you approved</li>
            <li><Icon name="chart" /> 48-hour ad check-up{nextCycle ? ` — next ${dateTime(nextCycle)}` : ""}</li>
            <li><Icon name="sparkle" /> Daily report — every morning at 7:00</li>
          </ul>
          <p className="muted small">Nothing publishes, spends or books without your OK, whatever the schedule says.</p>
        </section>
      </div>
    </>
  );
}
