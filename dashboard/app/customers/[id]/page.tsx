import Link from "next/link";
import { notFound } from "next/navigation";
import { PrintButton } from "@/components/PrintButton";
import { SERVICE_LABEL, money, phonePretty } from "@/lib/format";
import { requireOwnerPage } from "@/lib/session";
import { getCustomerAudit } from "@/lib/queries";

export const dynamic = "force-dynamic";

const full = (iso: string) => new Date(iso).toLocaleString("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "short",
  day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

/**
 * The audit report for one person: every step from the post they saw to the booking, with exact times and
 * reference ids. Built only from the database (the system of record), so it can be shown to a client as proof.
 */
export default async function CustomerAuditPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwnerPage();
  const { id } = await params;
  const a = await getCustomerAudit(id);
  if (!a) notFound();
  const { lead, source, quote, appointment, events } = a;
  const service = SERVICE_LABEL[lead.service_requested] ?? lead.service_requested;
  // How long from the customer's first move (comment or form) to the last step.
  const first = events.find((e) => e.tone === "customer")?.at, last = events.at(-1)?.at;
  const mins = first && last ? Math.max(0, Math.round((new Date(last).getTime() - new Date(first).getTime()) / 60000)) : null;

  return (
    <article className="audit rise">
      <nav className="audit-nav"><Link href="/customers">← All customers</Link><PrintButton /></nav>
      <header className="audit-head">
        <p className="eyebrow">Audit report · generated {full(new Date().toISOString())}</p>
        <h1>{lead.name}</h1>
        <p className="hero-line">{service} · {lead.contact_pref === "text" ? "booked by text" : "reached by phone"}
          {appointment ? <> · visit <strong>{full(appointment.scheduled_for)}</strong> ({appointment.status === "scheduled" ? "confirmed" : appointment.status.replace("_", " ")})</> : null}</p>
      </header>

      <div className="audit-facts">
        <section>
          <h2>Where they came from</h2>
          {source?.ad_name ? (
            <>
              <p><strong>{source.ad_name}</strong>{source.variant_label ? ` — variant ${source.variant_label}` : ""}</p>
              {source.headline && <p className="muted">“{source.headline}” on {source.platform === "instagram" ? "Instagram" : "Facebook"}</p>}
              {source.post_id && <p className="ref">post {source.post_id}</p>}
            </>
          ) : <p>{source?.kind === "lead_form" ? "Facebook lead form" : "Unknown source"} <span className="muted">(not forced onto an ad)</span></p>}
          {source?.comment && <p className="quote">“{source.comment}”</p>}
        </section>
        <section>
          <h2>Consent (CASL)</h2>
          {lead.consent_given ? (
            <>
              <p>Given {lead.consent_at ? full(lead.consent_at) : ""} via {lead.consent_source}</p>
              <p className="quote small">“{lead.consent_text}”</p>
              {lead.consent_withdrawn_at && <p className="pill bad">Withdrawn {full(lead.consent_withdrawn_at)}</p>}
            </>
          ) : <p className="pill bad">No consent on record — never contacted automatically</p>}
        </section>
        <section>
          <h2>Contact &amp; order</h2>
          <p>{phonePretty(lead.phone_e164) ?? lead.phone ?? "—"}{lead.city ? ` · ${lead.city}` : ""}</p>
          {quote ? (
            <p>Quote: {quote.price_cad !== null ? money(Number(quote.price_cad)) : "free in-home estimate"}
              {quote.price_basis === "fixed" ? " + HST" : quote.price_basis === "service_call" ? " service call" : ""} · {quote.status}</p>
          ) : <p className="muted">No text quote (reached by phone)</p>}
          {appointment?.calendar_event_id && <p className="ref">calendar {appointment.calendar_event_id}</p>}
        </section>
      </div>

      <section>
        <h2 className="audit-h2">Timeline {mins !== null && <span className="muted small">· {events.length} steps · {mins < 1 ? "under a minute" : `${mins} min`} from first contact to the last step</span>}</h2>
        <ol className="timeline">
          {events.map((e, i) => (
            <li key={i} className={`t-${e.tone ?? "agent"}`}>
              <time dateTime={e.at}>{full(e.at)}</time>
              <div>
                <p><strong>{e.actor}</strong> · {e.title}</p>
                {e.detail && <p className="t-detail">{e.detail}</p>}
                {e.ref && <p className="ref">{e.ref}</p>}
              </div>
            </li>
          ))}
        </ol>
      </section>
      <footer className="muted small audit-foot">
        Every line above comes from the platform&apos;s database. Texts and approvals can&apos;t be edited after the fact, and the activity
        log is append-only for everyone, including the administrator. Sandbox: the business and people are fictional.
      </footer>
    </article>
  );
}
