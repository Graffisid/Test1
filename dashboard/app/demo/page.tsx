import { readFileSync } from "node:fs";
import path from "node:path";
import Link from "next/link";
import { SampleCall } from "@/components/SampleCall";
import { Icon } from "@/components/Icon";
import { Story, type StoryStep } from "@/components/demo/Story";
import { fmt } from "@/components/charts/fmt";
import { Poster, posterTheme } from "@/components/review/Poster";
import { SAMPLE_CALL } from "@/lib/sample-call";
import { SERVICE_LABEL, TZ, phonePretty } from "@/lib/format";
import { requireOwnerPage } from "@/lib/session";
import { getCustomerAudit, getPeriodReport, getShowcaseCandidates, type CustomerAudit } from "@/lib/queries";

export const dynamic = "force-dynamic";

const STEPS: { title: string; body: string; behind: string }[] = [
  { title: "Open the customer's phone next to this dashboard",
    body: "It shows Northshore's latest ad as a Facebook post, plus a Messages app. Put the two windows side by side.",
    behind: "The phone is pretend; everything it sends goes into the real platform through signed webhooks, like Facebook and Twilio would." },
  { title: "Comment on the post as a customer",
    body: "Keep the example (“How much for a furnace tune-up?”) or type your own, then tap Comment. Within seconds Northshore replies publicly with a personal quote link.",
    behind: "The social media teammate sorts the comment as buying intent and traces it to the exact ad. The assistant replies with an approved template only." },
  { title: "Tap “Get a quote →” and fill in the form",
    body: "Name, phone, service, choose “Text me a quote”, tick the consent box, Send.",
    behind: "The consent wording, version and time are stored with the lead (CASL). The link works once and expires." },
  { title: "Open Messages on the phone",
    body: "The quote arrives in about a second. Reply YES, then pick a time by replying 1, 2 or 3.",
    behind: "The phone assistant only quotes prices from your price list and only sends approved texts. Anything else comes to you." },
  { title: "Watch this dashboard ring",
    body: "A “New booking” alert pops up. On Needs your OK, the booking card shows who, what, when, the price, and where they came from. Click Confirm booking.",
    behind: "The time is held on the calendar but not confirmed. Only you can confirm, and the database enforces that." },
  { title: "Back on the phone: the confirmation text arrives",
    body: "“You're booked!” The visit is now on the calendar.",
    behind: "If you decline instead, the time is released and the customer gets a polite “we'll call you” text." },
  { title: "Show the proof: Customers → open the person",
    body: "The audit report shows every step with exact times: the ad, the comment, the reply, the form and consent, every text, your decision. Print it or save it as a PDF.",
    behind: "It's built only from the database. Texts and decisions can't be edited after the fact." },
  { title: "Optional: show the off switch",
    body: "Connections (in your profile) → switch off “Twilio (phone & texts)” and repeat a step: nothing is sent. Switch it back on.",
    behind: "The switch is enforced by the database for every agent, not just hidden in the app." },
];

const at = (iso: string) => new Date(iso).toLocaleString("en-CA", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function gap(from: string | null | undefined, to: string | null | undefined): string | null {
  if (!from || !to) return null;
  const s = Math.max(0, (new Date(to).getTime() - new Date(from).getTime()) / 1000);
  return s < 90 ? `+${Math.round(s)}s` : s < 5400 ? `+${Math.round(s / 60)} min` : s < 172800 ? `+${Math.round(s / 3600)} h` : `+${Math.round(s / 86400)} days`;
}
const platformName = (p: string | null) => (p === "instagram" ? "Instagram" : "Facebook");

/** The story of one real customer, step by step, from the records. */
function storyFor(a: CustomerAudit): { steps: StoryStep[]; total: string } {
  const { lead, source, appointment, reply, calls, texts, journey } = a;
  const first = lead.name.split(" ")[0];
  const service = SERVICE_LABEL[lead.service_requested] ?? lead.service_requested;
  const contactAt = journey.find((j) => j.key === "contact")?.at ?? lead.created_at;
  const firstCall = calls[0];
  const firstText = texts.find((t) => t.direction === "outbound");
  const steps: StoryStep[] = [];
  if (source?.headline) {
    steps.push({ key: "post", when: source.published_at ? at(source.published_at) : "Live ad", gap: null,
      title: `Your ad runs on ${platformName(source.platform)}`, caption: `“${source.headline}” — written by your social media teammate, approved by you, then published.`,
      visual: <div className="sv-phone"><Poster uid={`demo-${lead.id.slice(0, 6)}`} headline={source.headline} format="ad" theme={posterTheme(source.headline)} cta="Get a call back" /></div> });
  }
  if (source?.comment) {
    steps.push({ key: "comment", when: at(contactAt), gap: gap(source.published_at, contactAt),
      title: `${first} comments`, caption: `A real question from a potential customer, right under the ad.`,
      visual: <div className="sv-chat"><p className="sv-bubble them"><b>{source.author ?? first}</b>{source.comment}</p></div> });
  }
  if (reply) {
    steps.push({ key: "reply", when: at(reply.at), gap: gap(contactAt, reply.at),
      title: "Your assistant replies in seconds", caption: "An approved reply only, with a personal one-time quote link. Angry or unclear comments go to you instead.",
      visual: <div className="sv-chat"><p className="sv-bubble them"><b>{source?.author ?? first}</b>{source?.comment}</p><p className="sv-bubble us"><b>Northshore Plumbing &amp; Heating</b>{reply.text}</p></div> });
  }
  steps.push({ key: "form", when: at(lead.created_at), gap: gap(reply?.at ?? contactAt, lead.created_at),
    title: `${first} asks for a quote`, caption: `Name, number and service — and the consent box, ticked by ${first}, with the exact wording stored (CASL).`,
    visual: <div className="sv-form"><p><span>Name</span><b>{lead.name}</b></p><p><span>Phone</span><b>{(phonePretty(lead.phone_e164) ?? "").replace(/\d{2}$/, "••")}</b></p>
      <p><span>Service</span><b>{service}</b></p><p className="sv-tick"><span className="sv-box">✓</span> Yes, Northshore may {lead.contact_pref === "text" ? "text" : "call"} me about my request</p></div> });
  if (firstCall) {
    steps.push({ key: "call", when: at(firstCall.started_at), gap: gap(lead.created_at, firstCall.started_at),
      title: `Called back in ${gap(lead.created_at, firstCall.started_at)?.slice(1)}`, caption: firstCall.transcript_summary ?? "The phone assistant calls, answers questions and offers times.",
      visual: <div className="sv-call"><span className="sv-call-ic"><Icon name="phone" /></span><b>Calling {first}…</b><span className="muted small">{firstCall.duration_s ? `${Math.round(firstCall.duration_s / 60)} min call` : "connected"} · {firstCall.outcome.replaceAll("_", " ")}</span></div> });
  } else if (firstText) {
    steps.push({ key: "text", when: at(firstText.sent_at), gap: gap(lead.created_at, firstText.sent_at),
      title: `Texted a quote in ${gap(lead.created_at, firstText.sent_at)?.slice(1)}`, caption: "Prices only from your price list, wording only from your approved templates.",
      visual: <div className="sv-chat">{texts.slice(0, 3).map((t, n) => <p key={n} className={`sv-bubble ${t.direction === "outbound" ? "us" : "them"}`}>{t.body}</p>)}</div> });
  }
  if (appointment) {
    const when = new Date(appointment.scheduled_for);
    steps.push({ key: "booked", when: at(appointment.created_at), gap: gap(firstCall?.started_at ?? firstText?.sent_at ?? lead.created_at, appointment.created_at),
      title: "Booked on your calendar", caption: `${service} for ${first}, at a time that suits them — confirmed with you before it's final.`,
      visual: <div className="sv-cal"><span className="sv-cal-m">{when.toLocaleDateString("en-CA", { timeZone: TZ, month: "short" })}</span>
        <span className="sv-cal-d">{when.toLocaleDateString("en-CA", { timeZone: TZ, day: "numeric" })}</span>
        <span className="sv-cal-t">{when.toLocaleTimeString("en-CA", { timeZone: TZ, hour: "numeric", minute: "2-digit" })} · {service}</span></div> });
  }
  if (appointment?.paid_at) {
    steps.push({ key: "paid", when: at(appointment.paid_at), gap: gap(appointment.created_at, appointment.paid_at),
      title: "Job done — paid", caption: `From a comment to money in the bank, with every step on record.`,
      visual: <div className="sv-paid"><span className="sv-paid-amt">{fmt("money", Number(appointment.paid_amount_cad))}</span><span>Paid · {service}</span><span className="sv-paid-ok"><Icon name="check" /> Customer for life</span></div> });
  }
  const bookedGap = gap(contactAt, appointment?.created_at), paidGap = gap(contactAt, appointment?.paid_at);
  const total = `${bookedGap ? `Comment to booked: ${bookedGap.slice(1)}` : ""}${paidGap ? ` · to paid: ${paidGap.slice(1)}` : ""}${appointment?.paid_amount_cad ? ` · ${fmt("money", Number(appointment.paid_amount_cad))} collected` : ""}`;
  return { steps, total };
}

export default async function Demo({ searchParams }: { searchParams: Promise<{ n?: string }> }) {
  await requireOwnerPage();
  const sandbox = process.env.DEMO_MODE === "1";
  const phoneUrl = process.env.DEMO_PHONE_URL || "http://127.0.0.1:3002";
  let voiced: number[] = [];
  try {
    const m = JSON.parse(readFileSync(path.join(process.cwd(), "public", "demo-call", "manifest.json"), "utf8"));
    voiced = Array.isArray(m.lines) ? m.lines.filter((n: unknown) => Number.isInteger(n)) : [];
  } catch { /* no audio generated yet: read-along */ }
  const { n } = await searchParams;
  const [ids, month] = await Promise.all([getShowcaseCandidates(), getPeriodReport(30)]);
  const idx = ids.length ? ((Number(n) || 0) % ids.length + ids.length) % ids.length : 0;
  const audit = ids.length ? await getCustomerAudit(ids[idx]) : null;
  const story = audit ? storyFor(audit) : null;
  const c = month.cur;
  const roas = c.spend > 0 ? c.revenue / c.spend : null;

  return (
    <>
      <header className="page-head rise">
        <div>
          <p className="eyebrow">Demo</p>
          <h1>From a reel to a paying customer</h1>
          <p className="page-sub">A real customer&apos;s journey from your records — the ad they saw, what they wrote, how fast your team answered, the booking and the payment.
            Press <strong>Present</strong> to walk a business owner through it.</p>
        </div>
        {ids.length > 1 && <Link className="btn" href={`/demo?n=${idx + 1}`}><Icon name="users" /> Show another customer</Link>}
      </header>

      {story && audit ? (
        <section className="card rise" aria-labelledby="story-title">
          <header className="card-head">
            <div><p className="eyebrow">{audit.lead.name} · {SERVICE_LABEL[audit.lead.service_requested] ?? audit.lead.service_requested}</p>
              <h2 id="story-title">{story.total}</h2></div>
            <Link className="btn small ghost" href={`/customers/${audit.lead.id}`}>Full audit trail →</Link>
          </header>
          <Story steps={story.steps} total={story.total} />
        </section>
      ) : <div className="empty-state"><Icon name="users" /><p>No customer has gone all the way from a comment to paid yet.</p></div>}

      <section className="card rise" aria-labelledby="month-title">
        <header className="card-head"><div><p className="eyebrow">Last 30 days · the same machine, every day</p><h2 id="month-title">What it adds up to</h2></div>
          <Link className="btn small ghost" href="/digest?period=30">Full report →</Link></header>
        <ol className="plain big-funnel">
          {[
            { label: "People reached", v: fmt("compact", c.reach) },
            { label: "Enquiries", v: fmt("int", c.leads) },
            { label: "Called back", v: fmt("int", c.calls), note: c.calls ? `${Math.round((c.within60 / c.calls) * 100)}% within a minute` : undefined },
            { label: "Jobs booked", v: fmt("int", c.booked) },
            { label: "Collected", v: fmt("money", c.revenue), note: roas ? `${roas.toFixed(1)}× your ${fmt("money", c.spend)} ad spend` : undefined },
          ].map((x, i) => (
            <li key={x.label}><span className="bf-n">{i + 1}</span><strong className="num">{x.v}</strong><span>{x.label}</span>{x.note && <span className="muted small">{x.note}</span>}</li>
          ))}
        </ol>
      </section>

      <div className="columns">
        <section className="panel rise" aria-labelledby="script-title">
          <header className="section-head">
            <h2 id="script-title">Run it live</h2>
            {sandbox ? <a className="btn small primary" href={phoneUrl} target="_blank" rel="noreferrer"><Icon name="phone" /> Open the customer&apos;s phone</a>
              : <span className="muted small">Live demo tools only run in the sandbox.</span>}
          </header>
          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={i}>
                <span className="step-n">{i + 1}</span>
                <div>
                  <strong>{s.title}</strong>
                  <p>{s.body}</p>
                  <p className="behind"><Icon name="sparkle" /> {s.behind}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
        <section className="panel rise" aria-labelledby="call-title">
          <header className="section-head">
            <h2 id="call-title">Hear a sample call</h2>
            <span className="muted small">For customers who choose “Call me”</span>
          </header>
          <p className="muted small">The live assistant uses an ElevenLabs voice over your Twilio number. It says it&apos;s an assistant, quotes only your
            prices, and leaves the final confirmation to you.</p>
          <SampleCall lines={SAMPLE_CALL.lines} agentName={SAMPLE_CALL.agentName} customerName={SAMPLE_CALL.customerName} voiced={voiced} />
        </section>
      </div>
    </>
  );
}
