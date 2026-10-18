import Link from "next/link";
import { Icon, type IconName } from "@/components/Icon";
import { fmt } from "@/components/charts/fmt";
import { requireOwnerPage } from "@/lib/session";
import { CHANNEL, SERVICE_LABEL, TZ, seconds } from "@/lib/format";
import { getCustomerTimeline, type TimelineRow } from "@/lib/queries";

export const dynamic = "force-dynamic";

const PERIODS = [7, 30, 90];
const STAGES = [
  { key: null, label: "Everyone" }, { key: "waiting", label: "In progress" }, { key: "booked", label: "Booked" },
  { key: "paid", label: "Paid" }, { key: "you", label: "Handed to you" }, { key: "lost", label: "Not interested" },
] as const;

const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-CA", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

function dayLabel(key: string, today: string, yesterday: string) {
  const d = new Date(`${key}T12:00:00Z`).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  return key === today ? `Today · ${d}` : key === yesterday ? `Yesterday · ${d}` : d;
}

function status(c: TimelineRow): { label: string; tone: string } {
  if (c.paid !== null) return { label: `Paid ${fmt("money", Number(c.paid))}`, tone: "good" };
  if (c.appt_status === "pending_owner") return { label: "Waiting for your OK", tone: "warn" };
  if (c.booked) return { label: "Booked", tone: "good" };
  if (c.appt_status === "no_show") return { label: "No-show", tone: "bad" };
  if (c.status === "handoff") return { label: "Handed to you", tone: "warn" };
  if (c.status === "lost") return { label: "Not interested", tone: "flat" };
  if (!c.consent) return { label: "No consent — call personally", tone: "warn" };
  if (c.reached_at) return { label: c.contact_pref === "text" ? "Texted" : "Called", tone: "accent" };
  return { label: "New", tone: "accent" };
}

export default async function Customers({ searchParams }: { searchParams: Promise<{ days?: string; channel?: string; stage?: string; q?: string }> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const days = PERIODS.includes(Number(sp.days)) ? Number(sp.days) : 30;
  const channel = sp.channel && CHANNEL[sp.channel] ? sp.channel : null;
  const stage = STAGES.some((s) => s.key === sp.stage) ? sp.stage! : null;
  const qText = (sp.q ?? "").trim().slice(0, 60) || null;
  const { rows, channels } = await getCustomerTimeline({ days, channel, stage, q: qText });

  const link = (over: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    const v = { days, channel, stage, q: qText, ...over };
    for (const [k, x] of Object.entries(v)) if (x !== null && x !== undefined && !(k === "days" && x === 30)) p.set(k, String(x));
    const s = p.toString();
    return s ? `/customers?${s}` : "/customers";
  };
  const total = channels.reduce((s, c) => s + c.n, 0), booked = channels.reduce((s, c) => s + c.booked, 0);
  const reached = rows.filter((r) => r.reached_at).length;
  const paidSum = rows.reduce((s, r) => s + (r.paid ? Number(r.paid) : 0), 0);
  const fast = rows.filter((r) => r.reached_at && new Date(r.reached_at).getTime() - new Date(r.created_at).getTime() <= 60_000).length;
  const maxCh = Math.max(...channels.map((c) => c.n), 1);
  const now = Date.now();
  const today = dayKey(new Date(now).toISOString()), yesterday = dayKey(new Date(now - 86_400_000).toISOString());
  const groups = new Map<string, TimelineRow[]>();
  for (const r of rows) groups.set(dayKey(r.created_at), [...(groups.get(dayKey(r.created_at)) ?? []), r]);

  return (
    <>
      <header className="page-head rise">
        <div>
          <p className="eyebrow">Customers</p>
          <h1>Every enquiry, from first contact to paid</h1>
          <p className="page-sub">Who reached out, when, on which channel and for what — and how far each person has got. Open anyone for their full journey and audit trail.</p>
        </div>
        <nav className="seg" aria-label="Period">
          {PERIODS.map((d) => <Link key={d} href={link({ days: d })} aria-current={d === days ? "page" : undefined} className={d === days ? "on" : ""}>{d} days</Link>)}
        </nav>
      </header>

      <div className="kpis four">
        <div className="kpi static"><span className="kpi-label">Enquiries</span><span className="kpi-value">{fmt("int", total)}</span><span className="kpi-prev">last {days} days, all channels</span></div>
        <div className="kpi static"><span className="kpi-label">Reached by your team</span><span className="kpi-value">{rows.length ? fmt("pct", reached / rows.length) : "—"}</span><span className="kpi-prev">{fmt("int", fast)} within a minute{channel || stage || qText ? " (filtered)" : ""}</span></div>
        <div className="kpi static"><span className="kpi-label">Booked</span><span className="kpi-value">{fmt("int", booked)}</span><span className="kpi-prev">{total ? fmt("pct", booked / total) : "—"} of enquiries</span></div>
        <div className="kpi static"><span className="kpi-label">Collected from them</span><span className="kpi-value">{fmt("money", paidSum)}</span><span className="kpi-prev">jobs done and paid{channel || stage || qText ? " (filtered)" : ""}</span></div>
      </div>

      <div className="cust-layout">
        <aside className="card cust-side rise" aria-label="Filters">
          <form action="/customers" className="search">
            {days !== 30 && <input type="hidden" name="days" value={days} />}
            {channel && <input type="hidden" name="channel" value={channel} />}
            {stage && <input type="hidden" name="stage" value={stage} />}
            <input type="search" name="q" defaultValue={qText ?? ""} placeholder="Search by name" aria-label="Search by name" maxLength={60} />
          </form>
          <h2 className="side-h">By channel</h2>
          <ul className="plain ch-list">
            <li><Link href={link({ channel: null })} className={!channel ? "on" : ""}><span>All channels</span><strong>{total}</strong></Link></li>
            {channels.map((c) => {
              const meta = CHANNEL[c.channel] ?? { label: c.channel, icon: "chat" as IconName, tone: "web" };
              return (
                <li key={c.channel}>
                  <Link href={link({ channel: c.channel })} className={channel === c.channel ? "on" : ""}>
                    <span className={`ch-ic ch-${meta.tone}`}><Icon name={meta.icon} /></span><span>{meta.label}</span><strong>{c.n}</strong>
                    <svg viewBox="0 0 100 6" preserveAspectRatio="none" className="ch-bar" aria-hidden="true">
                      <rect width="100" height="6" className="fn-track" />
                      <rect width={(c.n / maxCh) * 100} height="6" className="s2" />
                      <rect width={(c.booked / maxCh) * 100} height="6" className="s1" />
                    </svg>
                    <small>{c.booked} booked · {c.n ? Math.round((c.booked / c.n) * 100) : 0}%</small>
                  </Link>
                </li>
              );
            })}
          </ul>
          <ul className="legend plain"><li><i className="sw s1" /> Booked</li><li><i className="sw s2" /> Not (yet) booked</li></ul>
          <h2 className="side-h">Where they are</h2>
          <div className="stage-chips">
            {STAGES.map((s) => <Link key={s.label} href={link({ stage: s.key })} className={`filter ${stage === s.key ? "on" : ""}`}>{s.label}</Link>)}
          </div>
        </aside>

        <section className="cust-timeline" aria-label="Contact timeline">
          {rows.length === 0 && <div className="empty-state"><Icon name="users" /><p>No one matches. Try another period or filter.</p></div>}
          {[...groups.entries()].map(([key, list]) => (
            <div key={key} className="tl-day rise">
              <h2 className="tl-date">{dayLabel(key, today, yesterday)} <span className="muted small">· {list.length} {list.length === 1 ? "person" : "people"}</span></h2>
              <ol className="plain tl-list">
                {list.map((c) => {
                  const meta = CHANNEL[c.channel] ?? { label: c.channel, icon: "chat" as IconName, tone: "web" };
                  const st = status(c);
                  const speed = c.reached_at ? (new Date(c.reached_at).getTime() - new Date(c.created_at).getTime()) / 1000 : null;
                  const steps = [true, !!c.reached_at, !!c.booked || c.paid !== null, c.paid !== null];
                  return (
                    <li key={c.id}>
                      <Link href={`/customers/${c.id}`} className="tl-row">
                        <time className="tl-time" dateTime={c.created_at}>{time(c.created_at)}</time>
                        <span className={`tl-dot ch-${meta.tone}`}><Icon name={meta.icon} /></span>
                        <div className="tl-main">
                          <p className="tl-name"><strong>{c.name}</strong> <span className="pill flat">{SERVICE_LABEL[c.service_requested] ?? c.service_requested}</span></p>
                          <p className="muted small">{meta.label}{c.ad_name ? ` · from “${c.ad_name}”` : ""} · prefers {c.contact_pref === "text" ? "texts" : "a call"}
                            {speed !== null && speed >= 0 ? ` · reached in ${seconds(speed)}` : ""}</p>
                        </div>
                        <ol className="plain journey-dots" aria-label={`Journey: ${["Reached out", "Contacted", "Booked", "Paid"].filter((_, i) => steps[i]).join(", ")}`}>
                          {["Reached out", "Contacted", "Booked", "Paid"].map((l, i) => <li key={l} className={steps[i] ? "on" : ""} title={l}><span>{l}</span></li>)}
                        </ol>
                        <span className={`pill ${st.tone}`}>{st.label}</span>
                        <Icon name="arrowRight" className="tl-go" />
                      </Link>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
