import { existsSync } from "node:fs";
import path from "node:path";
import { SampleCall } from "@/components/SampleCall";
import { Icon } from "@/components/Icon";
import { SAMPLE_CALL } from "@/lib/sample-call";
import { requireOwnerPage } from "@/lib/session";

export const dynamic = "force-dynamic";

const STEPS: { title: string; body: string; behind: string }[] = [
  { title: "Open the customer's phone next to this dashboard",
    body: "It shows Northshore's latest ad as a Facebook post, plus a Messages app. Put the two windows side by side.",
    behind: "The phone is pretend; everything it sends goes into the real platform through signed webhooks, like Facebook and Twilio would." },
  { title: "Comment on the post as a customer",
    body: "Keep the example (“How much for a furnace tune-up?”) or type your own, then tap Comment. Within seconds Northshore replies publicly with a personal quote link.",
    behind: "Inbox sorter classifies the comment as buying intent and traces it to the exact ad. Lead catcher replies with an approved template only." },
  { title: "Tap “Get a quote →” and fill in the form",
    body: "Name, phone, service, choose “Text me a quote”, tick the consent box, Send.",
    behind: "The consent wording, version and time are stored with the lead (CASL). The link works once and expires." },
  { title: "Open Messages on the phone",
    body: "The quote arrives in about a second. Reply YES, then pick a time by replying 1, 2 or 3.",
    behind: "The phone assistant only quotes prices from your price list and only sends approved texts. Anything else comes to you." },
  { title: "Watch this dashboard ring",
    body: "A “New booking” alert pops up. On Today, the booking card shows who, what, when, the price, and where they came from. Click Confirm booking.",
    behind: "The time is held on the calendar but not confirmed. Only you can confirm, and the database enforces that." },
  { title: "Back on the phone: the confirmation text arrives",
    body: "“You're booked!” The visit is now on the calendar.",
    behind: "If you decline instead, the time is released and the customer gets a polite “we'll call you” text." },
  { title: "Show the proof: Customers → open the person",
    body: "The audit report shows every step with exact times: the ad, the comment, the reply, the form and consent, every text, your decision. Print it or save it as a PDF.",
    behind: "It's built only from the database. Texts and decisions can't be edited after the fact." },
  { title: "Optional: show the off switch",
    body: "Connections → switch off “Twilio (phone & texts)” and repeat a step: nothing is sent. Switch it back on.",
    behind: "The switch is enforced by the database for every agent, not just hidden in the app." },
];

export default async function Demo() {
  await requireOwnerPage();
  const sandbox = process.env.DEMO_MODE === "1";
  const phoneUrl = process.env.DEMO_PHONE_URL || "http://127.0.0.1:3002";
  const hasAudio = existsSync(path.join(process.cwd(), "public", "demo-call", "manifest.json"));
  return (
    <>
      <section className="hero rise">
        <p className="eyebrow">Demo</p>
        <h1>Show a business owner the whole thing</h1>
        <p className="hero-line">From a Facebook comment to a confirmed booking in about two minutes, with a full audit trail at the end.</p>
        {sandbox ? (
          <a className="hero-cta" href={phoneUrl} target="_blank" rel="noreferrer">
            <span className="hero-badge"><Icon name="phone" /></span> Open the customer&apos;s phone <Icon name="arrowUp" />
          </a>
        ) : (
          <p className="hero-cta done">Demo tools only run in the sandbox (npm run sandbox).</p>
        )}
      </section>

      <div className="columns">
        <section className="panel rise" aria-labelledby="script-title">
          <header className="section-head"><h2 id="script-title">The script</h2></header>
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
          <SampleCall lines={SAMPLE_CALL.lines} agentName={SAMPLE_CALL.agentName} customerName={SAMPLE_CALL.customerName} hasAudio={hasAudio} />
        </section>
      </div>
    </>
  );
}
