import { CountUp, type NumberFormat } from "./CountUp";
import { Icon, type IconName } from "./Icon";
import { money, pct } from "@/lib/format";

interface Step { icon: IconName; value: number; format: NumberFormat; label: string; note: string }

/**
 * The whole business on one line: ad money in → people → calls → bookings → paid jobs.
 * Dots travel along each link to show work moving through; each link says how many made it to the next step.
 */
export function Flow({ f }: {
  f: { leads: number; called: number; booked: number; paid: number; revenue: number; spend: number; unknownLeads: number };
}) {
  const steps: Step[] = [
    { icon: "dollar", value: f.spend, format: "moneyWhole", label: "Spent on ads", note: "Facebook & Instagram" },
    { icon: "user", value: f.leads, format: "int", label: "People reached out", note: "asked for a call back" },
    { icon: "phone", value: f.called, format: "int", label: "Called back", note: "by your phone assistant" },
    { icon: "calendar", value: f.booked, format: "int", label: "Jobs booked", note: "on your calendar" },
    { icon: "check", value: f.paid, format: "int", label: "Paid", note: `${money(f.revenue, { cents: false })} collected` },
  ];
  const links = [
    f.leads ? `${money(f.spend / f.leads)} per person` : "—",
    f.leads ? `${pct(f.called / f.leads)} called` : "—",
    f.called ? `${pct(f.booked / f.called)} booked` : "—",
    f.booked ? `${pct(f.paid / f.booked)} paid so far` : "—",
  ];
  const roi = f.spend > 0 ? f.revenue / f.spend : null;

  return (
    <section className="flow-card rise" aria-labelledby="flow-title">
      <header className="flow-head">
        <div>
          <h2 id="flow-title">How your ads turn into jobs</h2>
          <p className="muted">Last 30 days, from first click to paid invoice</p>
        </div>
        {roi !== null && (
          <p className="roi">
            <span className="roi-value">{roi.toFixed(1)}×</span>
            <span className="roi-label">back for every $1 on ads</span>
          </p>
        )}
      </header>
      <ol className="flow">
        {steps.map((s, i) => (
          <li key={s.label} className="flow-step">
            <span className="flow-node"><Icon name={s.icon} /></span>
            <CountUp className="flow-value" value={s.value} format={s.format} />
            <span className="flow-label">{s.label}</span>
            <span className="flow-note">{s.note}</span>
            {i < links.length && (
              <span className="flow-link" aria-label={links[i]}>
                <span className="flow-dot" /><span className="flow-dot" /><span className="flow-dot" />
                <span className="flow-rate">{links[i]}</span>
              </span>
            )}
          </li>
        ))}
      </ol>
      {f.unknownLeads > 0 && (
        <p className="flow-foot muted">
          Plus {f.unknownLeads} people who found you another way (word of mouth, search). They aren&apos;t counted above.
        </p>
      )}
    </section>
  );
}
