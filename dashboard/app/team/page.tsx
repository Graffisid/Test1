import Link from "next/link";
import { Icon } from "@/components/Icon";
import { TeamSpark } from "@/components/TeamSpark";
import { Delta } from "@/components/charts/Delta";
import { fmt } from "@/components/charts/fmt";
import { requireOwnerPage } from "@/lib/session";
import { relative } from "@/lib/format";
import { getTeam } from "@/lib/team";

export const dynamic = "force-dynamic";

export default async function Team() {
  await requireOwnerPage();
  const team = await getTeam();
  const now = Date.now();
  return (
    <>
      <header className="page-head rise">
        <div>
          <p className="eyebrow">Your team</p>
          <h1>Six AI teammates, one owner</h1>
          <p className="page-sub">Each card shows what that teammate did in the last 7 days compared with the week before. Open one for its
            performance graph, what it&apos;s doing right now, its report, and the rules it can&apos;t break.</p>
        </div>
      </header>
      <div className="team-grid">
        {team.map((m) => {
          const recent = m.last && now - new Date(m.last.at).getTime() < 15 * 60_000;
          // Whole days only (today is still in progress): the last 7 complete days vs the 7 before.
          const week = m.series.slice(-8, -1).reduce((s, d) => s + d.n, 0), before = m.series.slice(-15, -8).reduce((s, d) => s + d.n, 0);
          return (
            <Link key={m.key} href={`/team/${m.key}`} className={`member m-${m.key}`}>
              <header className="member-head">
                <span className="member-icon"><Icon name={m.icon} /></span>
                <div><h2>{m.name}</h2><p className="muted small">{m.role}</p></div>
                <span className={`status-dot ${recent ? "live" : ""}`}>{recent ? "Working" : "Standing by"}</span>
              </header>
              <div className="member-main">
                <div><span className="member-num num">{fmt("int", week)}</span><span className="muted small"> {m.unit} this week</span>
                  <div><Delta cur={week} prev={before} /></div></div>
                <TeamSpark values={m.series.slice(-15, -1).map((d) => d.n)} />
              </div>
              <dl className="member-kpis">
                {m.kpis.slice(1, 3).map((k) => (
                  <div key={k.label}><dt>{k.label}</dt><dd className="num">{fmt(k.format, k.cur)}</dd></div>
                ))}
              </dl>
              <p className="member-last"><Icon name="clock" /> {m.last ? <>{m.last.text.length > 90 ? `${m.last.text.slice(0, 90)}…` : m.last.text} <span className="muted">· {relative(m.last.at, now)}</span></> : "Nothing yet"}</p>
              <span className="member-open">Open report <Icon name="arrowRight" /></span>
            </Link>
          );
        })}
      </div>
    </>
  );
}
