import Link from "next/link";
import { StatusChip } from "@/components/StatusChip";
import { KIND_LABEL, SERVICE_LABEL, dateTime, longDate, money, pct, relative, seconds } from "@/lib/format";
import { requireOwnerPage } from "@/lib/session";
import { expireStaleApprovals, getDigest } from "@/lib/queries";

export const dynamic = "force-dynamic";

function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

/**
 * The owner's one-page morning digest (skills/morning-digest/SKILL.md layout).
 * Every number comes straight from v_daily_kpis / the base tables so it reconciles by hand.
 */
export default async function DigestPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  await requireOwnerPage();
  const { date } = await searchParams;
  await expireStaleApprovals();
  const dg = await getDigest(date ?? null);
  const k = dg.kpi;
  const now = Date.now();
  const prev = shiftDay(dg.date, -1);
  const next = shiftDay(dg.date, 1);
  const bookedAndPaid = k ? `${k.booked} / ${k.paid_jobs}` : "—";

  const tiles: { label: string; value: string; note?: string }[] = k
    ? [
        { label: "Spend", value: money(k.spend_cad) },
        { label: "Leads", value: String(k.leads), note: `${k.paid_leads} from ads` },
        { label: "Cost per lead", value: money(k.cost_per_lead_cad) },
        { label: "Speed to lead", value: seconds(k.median_speed_to_lead_s), note: `${k.calls_within_60s}/${k.calls} ≤ 60s` },
        { label: "Calls", value: String(k.calls) },
        { label: "Bookings", value: String(k.booked) },
        { label: "Booked & paid", value: bookedAndPaid, note: `${money(k.revenue_cad)} collected` },
      ]
    : [];

  return (
    <article className="digest" aria-labelledby="digest-title">
      <nav className="digest-nav" aria-label="Digest date">
        {dg.date > dg.bounds.min ? <Link href={`/digest?date=${prev}`}>← {prev}</Link> : <span />}
        <span className="muted small">Morning digest · prepared by growth-director</span>
        {dg.date < dg.bounds.max ? <Link href={`/digest?date=${next}`}>{next} →</Link> : <span />}
      </nav>

      <header className="digest-head">
        <h1 id="digest-title">{longDate(dg.date)}</h1>
        {k ? (
          <p className="digest-headline">
            You spent <strong>{money(k.spend_cad)}</strong>, booked <strong>{k.booked} job{k.booked === 1 ? "" : "s"}</strong>,
            and collected <strong>{money(k.revenue_cad)}</strong>.
          </p>
        ) : (
          <p className="digest-headline">No data for this day.</p>
        )}
      </header>

      {k && (
        <section aria-label="Key numbers">
          <ul className="digest-tiles">
            {tiles.map((t) => (
              <li key={t.label}>
                <span className="tile-label">{t.label}</span>
                <span className="tile-value">{t.value}</span>
                {t.note && <span className="tile-note">{t.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="digest-grid">
        <section className="digest-block">
          <h2>Top ad</h2>
          {dg.topAd ? (
            <>
              <p className="big">{dg.topAd.ad_name} — variant {dg.topAd.label}</p>
              <p className="quote">“{dg.topAd.headline}”</p>
              <p>
                {money(dg.topAd.cpl)} per lead · {dg.topAd.leads} lead{dg.topAd.leads === 1 ? "" : "s"} on {money(dg.topAd.spend)}
                {dg.topAd.window === "7d" && <span className="muted"> (no ad leads this day — best over the 7 days ending here)</span>}
              </p>
            </>
          ) : (
            <p className="muted">No ad produced a lead in the past 7 days.</p>
          )}
        </section>

        <section className="digest-block">
          <h2>Top deal</h2>
          {dg.topDeal ? (
            <>
              <p className="big">{money(dg.topDeal.value, { cents: false })} · {SERVICE_LABEL[dg.topDeal.service] ?? dg.topDeal.service}</p>
              <p>
                {dg.topDeal.name}{dg.topDeal.city ? `, ${dg.topDeal.city}` : ""} · {dg.topDeal.booked ? "booked" : "not booked yet (estimate)"}
              </p>
              <p className="muted">Source: {dg.topDeal.ad_name ?? "Unknown source"}</p>
            </>
          ) : (
            <p className="muted">No new leads this day.</p>
          )}
        </section>

        <section className="digest-block">
          <h2>Waiting on you <span className="count">{dg.waiting.length}</span></h2>
          {dg.waiting.length ? (
            <ol className="plain waiting">
              {dg.waiting.map((a) => (
                <li key={a.id}>
                  <span className="kind">{KIND_LABEL[a.kind] ?? a.kind}</span> {a.title}
                  {a.needs_fact_check && <span className="chip chip-serious"><span aria-hidden="true">⚑</span> Unverified claim</span>}
                  <span className="muted small"> · waiting {relative(a.created_at, now).replace(" ago", "")}, expires {relative(a.expires_at, now)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">Nothing pending.</p>
          )}
          <p><Link href="/#queue-title">Review in the approvals queue →</Link></p>
        </section>

        <section className="digest-block">
          <h2>Escalations this day</h2>
          {dg.escalations.length ? (
            <ul className="plain escalations">
              {dg.escalations.map((e) => (
                <li key={e.id}>
                  <StatusChip status={e.status} /> <span className="muted small">{dateTime(e.occurred_at)} · {e.agent}</span>
                  <p>{e.decision}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">None.</p>
          )}
          <p className="muted small">{dg.openEscalatedComments} escalated comment{dg.openEscalatedComments === 1 ? "" : "s"} still open overall.</p>
        </section>
      </div>

      <section className="digest-block runcost">
        <h2>Run cost vs revenue</h2>
        <p>
          Estimated software &amp; API cost <strong>{money(dg.runCost)}</strong> vs revenue collected{" "}
          <strong>{money(k?.revenue_cad ?? 0)}</strong>
          {k && dg.runCost > 0 && k.revenue_cad > 0 ? <> — {pct(dg.runCost / k.revenue_cad)} of revenue</> : null}.
          <span className="muted"> Ad spend is separate ({money(k?.spend_cad ?? 0)}). Mock estimates — no paid API was called.</span>
        </p>
      </section>

      <footer className="muted small digest-foot">
        Numbers reconcile with <code>v_daily_kpis</code> for {dg.date}. Leads with no ad are reported as “unknown source”, never forced onto an ad.
      </footer>
    </article>
  );
}
