import Link from "next/link";
import { CuMark } from "@/components/CuMark";
import { Icon } from "@/components/Icon";
import { requireOwnerPage } from "@/lib/session";
import { getPortfolio, getRules } from "@/lib/oncu";
import { money } from "@/lib/story";

export const dynamic = "force-dynamic";

const SHOW = [
  { key: "all", label: "All" }, { key: "ready", label: "Ready for a story" }, { key: "profile", label: "Profile only" },
] as const;

export default async function CreditUnions({ searchParams }: { searchParams: Promise<{ show?: string; pain?: string; q?: string }> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const [all, rules] = await Promise.all([getPortfolio(), getRules()]);
  const show = SHOW.some((s) => s.key === sp.show) ? sp.show! : "all";
  const pain = rules.some((r) => r.key === sp.pain) ? sp.pain! : null;
  const qText = (sp.q ?? "").trim().slice(0, 60).toLowerCase() || null;
  const rows = all.filter((c) => (show === "all" || (show === "ready" ? c.enough : !c.enough))
    && (!pain || c.pains.some((p) => p.key === pain))
    && (!qText || `${c.name} ${c.short_name} ${c.city ?? ""}`.toLowerCase().includes(qText)));
  const link = (over: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ show: show === "all" ? null : show, pain, q: qText, ...over })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/credit-unions?${s}` : "/credit-unions";
  };
  const painCount = (key: string) => all.filter((c) => c.pains.some((p) => p.key === key)).length;

  return (
    <>
      <header className="page-head rise">
        <div>
          <p className="eyebrow">Credit unions</p>
          <h1>{all.length} Ontario credit unions</h1>
          <p className="page-sub">The active roster from ONCU Insights. Credit unions with three or more years of audited numbers get a full story;
            the rest show their profile until ONCU captures more.</p>
        </div>
        <nav className="seg" aria-label="Show">
          {SHOW.map((s) => <Link key={s.key} href={link({ show: s.key === "all" ? null : s.key })} className={show === s.key ? "on" : ""}
            aria-current={show === s.key ? "page" : undefined}>{s.label}</Link>)}
        </nav>
      </header>

      <div className="cust-layout">
        <aside className="card cust-side rise" aria-label="Filters">
          <form action="/credit-unions" className="search">
            {show !== "all" && <input type="hidden" name="show" value={show} />}
            {pain && <input type="hidden" name="pain" value={pain} />}
            <input type="search" name="q" defaultValue={qText ?? ""} placeholder="Search by name or city" aria-label="Search by name or city" maxLength={60} />
          </form>
          <h2 className="side-h">By pain point</h2>
          <div className="stage-chips">
            <Link href={link({ pain: null })} className={`filter ${!pain ? "on" : ""}`}>Any</Link>
            {rules.filter((r) => r.active).map((r) => (
              <Link key={r.key} href={link({ pain: r.key })} className={`filter ${pain === r.key ? "on" : ""}`}>{r.title} · {painCount(r.key)}</Link>
            ))}
          </div>
        </aside>

        <section aria-label="Credit unions">
          {rows.length === 0 && <div className="empty-state"><Icon name="info" /><p>No credit union matches. Try another filter.</p></div>}
          <ol className="plain tl-list">
            {rows.map((c) => (
              <li key={c.id}>
                <Link href={`/credit-unions/${c.id}`} className="cu-row">
                  <CuMark name={c.short_name} color={c.brand_primary} />
                  <div className="tl-main">
                    <p className="tl-name"><strong>{c.name}</strong>{c.city && <span className="muted small">{c.city}</span>}</p>
                    <p className="muted small">
                      {c.latest_assets ? `${money(c.latest_assets)} assets · ` : ""}{c.years ? `${c.years} year${c.years === 1 ? "" : "s"} of numbers` : "No audited numbers yet"}
                      {c.pains.length ? ` · ${c.pains.map((p) => p.title).join(" · ")}` : ""}
                    </p>
                  </div>
                  {c.enough
                    ? <span className={`pill ${c.waiting ? "warn" : "good"}`}>{c.waiting ? `${c.waiting} to review` : "All reviewed"}</span>
                    : <span className="pill flat">Profile only</span>}
                  <Icon name="arrowRight" />
                </Link>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
