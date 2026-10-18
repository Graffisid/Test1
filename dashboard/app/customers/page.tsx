import Link from "next/link";
import { requireOwnerPage } from "@/lib/session";
import { SERVICE_LABEL, dateTime, relative } from "@/lib/format";
import { getCustomers, type CustomerRow } from "@/lib/queries";

export const dynamic = "force-dynamic";

/** Where each person is in the journey, in plain words. */
function stage(c: CustomerRow): { label: string; tone: string } {
  if (c.appt_status === "scheduled" || c.appt_status === "completed") return { label: "Booked", tone: "good" };
  if (c.appt_status === "pending_owner") return { label: "Waiting for your OK", tone: "warn" };
  if (c.status === "lost") return { label: "Not interested", tone: "flat" };
  if (c.status === "handoff") return { label: "Handed to you", tone: "warn" };
  if (c.quote_status === "accepted") return { label: "Choosing a time", tone: "accent" };
  if (c.quote_status === "sent") return { label: "Quote sent", tone: "accent" };
  if (c.calls > 0) return { label: "Called", tone: "accent" };
  return { label: "New", tone: "accent" };
}

export default async function Customers() {
  await requireOwnerPage();
  const rows = await getCustomers();
  const now = Date.now();
  return (
    <>
      <section className="hero rise">
        <p className="eyebrow">Customers</p>
        <h1>Everyone who reached out</h1>
        <p className="hero-line">Open anyone to see their full audit trail: the post they saw, what they wrote, every message, and every decision.</p>
      </section>
      <section className="panel rise">
        <table className="cust">
          <thead><tr><th>Person</th><th>Wants</th><th>Came from</th><th>Where they are</th><th>When</th></tr></thead>
          <tbody>
            {rows.map((c) => {
              const s = stage(c);
              return (
                <tr key={c.id}>
                  <td><Link href={`/customers/${c.id}`} className="cust-name">{c.name}</Link>
                    <span className="muted small">{c.contact_pref === "text" ? "prefers texts" : "prefers a call"}</span></td>
                  <td>{SERVICE_LABEL[c.service_requested] ?? c.service_requested}</td>
                  <td>{c.ad_name ?? <span className="muted">Unknown source</span>}</td>
                  <td><span className={`pill ${s.tone}`}>{s.label}</span>
                    {c.scheduled_for && <span className="muted small"> {dateTime(c.scheduled_for)}</span>}</td>
                  <td className="muted small" title={dateTime(c.created_at)}>{relative(c.created_at, now)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}
