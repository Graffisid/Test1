import { ConnectionSwitch } from "@/components/ConnectionSwitch";
import { Icon, type IconName } from "@/components/Icon";
import { dateTime } from "@/lib/format";
import { requireOwnerPage } from "@/lib/session";
import { getIntegrations, getNextAdCycle, getSchedule } from "@/lib/queries";

export const dynamic = "force-dynamic";

const CATEGORY_ICON: Record<string, IconName> = {
  social: "megaphone", phone: "phone", voice: "sparkle", calendar: "calendar", media: "film", ai: "compass", alerts: "bell", research: "chart",
};
const MODE: Record<string, { label: string; tone: string }> = {
  simulated: { label: "Sandbox stand-in", tone: "warn" },
  live: { label: "Live", tone: "good" },
  not_set_up: { label: "Not set up", tone: "flat" },
};

export default async function Connections() {
  await requireOwnerPage();
  const [items, schedule, nextCycle] = await Promise.all([getIntegrations(), getSchedule(), getNextAdCycle()]);
  const onCount = items.filter((i) => i.enabled).length;
  const routines = [
    { icon: "inbox" as IconName, name: "Read and sort new comments, messages and forms", when: "Every few seconds (every minute when live)" },
    { icon: "phone" as IconName, name: "Call back or text new leads", when: "Within a minute of the form, every time" },
    { icon: "megaphone" as IconName, name: "Publish approved ads and posts", when: "Right after you approve (posts wait for their scheduled time)" },
    { icon: "chart" as IconName, name: "48-hour ad check-up: find winners and losers, suggest budget moves", when: nextCycle ? `Next: ${dateTime(nextCycle)}` : "Every 48 hours" },
    { icon: "sparkle" as IconName, name: "Daily report", when: "Every morning at 7:00" },
  ];

  return (
    <>
      <section className="hero rise">
        <p className="eyebrow">Connections</p>
        <h1>What your team is plugged into</h1>
        <p className="hero-line">
          <strong>{onCount} of {items.length}</strong> connections are on. Switch any of them off here: the database itself
          then refuses anything that needs it, for every agent. Nothing is lost; work waits until you switch it back on.
        </p>
      </section>

      <div className="conn-grid">
        {items.map((c) => (
          <article key={c.key} className={`conn rise ${c.enabled ? "" : "off"}`}>
            <header className="conn-head">
              <span className={`conn-icon cat-${c.category}`}><Icon name={CATEGORY_ICON[c.category] ?? "plug"} /></span>
              <div className="conn-titles">
                <h3>{c.name}</h3>
                <span className={`pill ${MODE[c.mode].tone}`}>{MODE[c.mode].label}</span>
              </div>
              <ConnectionSwitch k={c.key} name={c.name} on={c.enabled} settable={c.mode !== "not_set_up"} />
            </header>
            <p className="conn-purpose">{c.purpose}</p>
            <p className="conn-meta"><Icon name="users" /> Used by {c.used_by}</p>
            <p className="conn-meta"><Icon name="info" /> When off: {c.when_off}</p>
            {c.changed_at && <p className="conn-meta muted">Switched {c.enabled ? "on" : "off"} by {c.changed_by}, {dateTime(c.changed_at)}</p>}
          </article>
        ))}
      </div>

      <div className="columns">
        <section className="panel rise" aria-labelledby="sched-title">
          <header className="section-head"><h2 id="sched-title">Coming up</h2></header>
          {schedule.length === 0 && <p className="muted">Nothing scheduled yet.</p>}
          <ol className="plain sched">
            {schedule.map((s, i) => (
              <li key={i} className={`sched-${s.kind}`}>
                <span className="sched-when">{s.at ? dateTime(s.at) : s.kind === "publish" ? "Next run" : "Not yet"}</span>
                <div>
                  <strong>{s.href ? <a href={s.href}>{s.title}</a> : s.title}</strong>
                  <p className="muted small">{s.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
        <section className="panel rise" aria-labelledby="routine-title">
          <header className="section-head"><h2 id="routine-title">Automatic routines</h2></header>
          <ul className="plain routines">
            {routines.map((r) => (
              <li key={r.name}><span className="who"><Icon name={r.icon} /></span><div><strong>{r.name}</strong><p className="muted small">{r.when}</p></div></li>
            ))}
          </ul>
          <p className="muted small">Nothing publishes, spends or books without your OK, whatever the schedule says.</p>
        </section>
      </div>
    </>
  );
}
