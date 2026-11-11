/**
 * The story engine: turns one credit union's audited and official ONCU numbers into
 *   - year chapters ("where you've been"),
 *   - pain points, each from a plain rule and mapped to a Trisanga offering ("what's in the way"),
 * as claims the owner approves before any video may use them.
 *
 * Pure and deterministic: the same numbers always give the same claims and the same hashes.
 * Every claim lists the exact numbers it rests on, with ONCU's classification and source ids.
 * ONCU's interpretations, voice data and pending findings are never turned into claims here.
 */
import { createHash } from "node:crypto";

export interface MetricValue { year: number; metric: string; value: number; classification: string; source_ids: string[] }
export interface Rule { key: string; title: string; test: string; offering_key: string; active: boolean }
export interface Evidence { label: string; year: number; metric: string; value: number; display: string; classification: string; sources: string[] }
export interface Claim { key: string; kind: "chapter" | "trend" | "pain"; title: string; text: string; evidence: Evidence[]; sources: string[]; hash: string }
export interface PainPoint extends Claim { kind: "pain"; rule: string; offering_key: string; severity: number }
export interface Story {
  years: number[];
  enough: boolean;
  series: Record<string, { year: number; value: number }[]>;
  chapters: Claim[];
  trends: Claim[];
  pains: PainPoint[];
}

import { display, label, money, pct } from "./numbers";
export { display, label, money, pct };

function hashOf(key: string, text: string, ev: Evidence[]): string {
  return createHash("sha256").update(JSON.stringify([key, text, ev.map((e) => [e.metric, e.year, e.value, e.classification])])).digest("hex");
}
function claim(key: string, kind: Claim["kind"], title: string, text: string, evidence: Evidence[]): Claim {
  const sources = [...new Set(evidence.flatMap((e) => e.sources))].sort();
  return { key, kind, title, text, evidence, sources, hash: hashOf(key, text, evidence) };
}

export function buildStory(name: string, values: MetricValue[], rules: Rule[]): Story {
  const by = new Map<string, Map<number, MetricValue>>();
  for (const v of values) {
    if (!by.has(v.metric)) by.set(v.metric, new Map());
    by.get(v.metric)!.set(v.year, v);
  }
  const get = (m: string, y: number) => by.get(m)?.get(y);
  const ev = (m: string, y: number): Evidence | null => {
    const v = get(m, y);
    return v ? { label: label(m), year: y, metric: m, value: v.value, display: display(m, v.value), classification: v.classification, sources: v.source_ids } : null;
  };
  const yearsOf = (m: string) => [...(by.get(m)?.keys() ?? [])].sort((a, b) => a - b);
  const years = [...new Set(values.map((v) => v.year))].sort((a, b) => a - b);
  const series: Story["series"] = {};
  for (const m of by.keys()) series[m] = yearsOf(m).map((y) => ({ year: y, value: by.get(m)!.get(y)!.value }));

  // Chapters: one per year with at least assets or net income.
  const chapters: Claim[] = [];
  for (const y of years) {
    const parts = [ev("assets", y), ev("netIncome", y), ev("deposits", y), ev("members", y)].filter((e): e is Evidence => !!e);
    if (!parts.some((p) => p.metric === "assets" || p.metric === "netIncome")) continue;
    const bits = parts.map((p) => p.metric === "assets" ? `held ${p.display} in assets`
      : p.metric === "netIncome" ? (p.value < 0 ? `recorded a net loss of ${money(-p.value)}` : `earned ${p.display}`)
      : p.metric === "deposits" ? `looked after ${p.display} in member deposits` : `served ${p.display} members`);
    const text = `In FY${y}, ${name} ${bits.length > 1 ? `${bits.slice(0, -1).join(", ")} and ${bits.at(-1)}` : bits[0]}.`;
    chapters.push(claim(`chapter:${y}`, "chapter", `FY${y}`, text, parts));
  }

  // Trends across the whole period.
  const trends: Claim[] = [];
  const span = (m: string) => { const ys = yearsOf(m); return ys.length >= 2 ? [ys[0], ys.at(-1)!] as const : null; };
  const a = span("assets");
  if (a) {
    const [f, l] = [ev("assets", a[0])!, ev("assets", a[1])!];
    const change = (l.value / f.value - 1) * 100;
    trends.push(claim("trend:assets", "trend", "Five-year growth",
      `Assets ${change >= 0 ? "grew" : "shrank"} from ${f.display} in FY${a[0]} to ${l.display} in FY${a[1]} (${change >= 0 ? "+" : ""}${pct(change)}).`, [f, l]));
  }
  const ni = span("netIncome");
  if (ni) {
    const [f, l] = [ev("netIncome", ni[0])!, ev("netIncome", ni[1])!];
    trends.push(claim("trend:earnings", "trend", "Earnings over the period",
      `Net income went from ${f.display} in FY${ni[0]} to ${l.display} in FY${ni[1]}.`, [f, l]));
  }

  // Pain points.
  const pains: PainPoint[] = [];
  const active = new Map(rules.filter((r) => r.active).map((r) => [r.key, r]));
  const pain = (key: string, text: string, evidence: Evidence[], severity: number) => {
    const r = active.get(key);
    if (!r) return;
    pains.push({ ...claim(`pain:${key}`, "pain", r.title, text, evidence) as Claim & { kind: "pain" }, rule: key, offering_key: r.offering_key, severity });
  };
  const last = (m: string) => yearsOf(m).at(-1);

  const yN = last("netIncome");
  if (yN !== undefined) {
    const cur = ev("netIncome", yN)!, prev = ev("netIncome", yN - 1);
    if (cur.value < 0) pain("earnings-pressure", `${name} recorded a net loss of ${money(-cur.value)} in FY${yN}${prev ? `, after ${prev.value < 0 ? `a loss of ${money(-prev.value)}` : `earning ${prev.display}`} in FY${yN - 1}` : ""}.`,
      prev ? [prev, cur] : [cur], 3);
    else if (prev && prev.value > 0 && cur.value <= prev.value * 0.7)
      pain("earnings-pressure", `Net income fell from ${prev.display} in FY${yN - 1} to ${cur.display} in FY${yN} (${pct((cur.value / prev.value - 1) * 100, 0)}).`, [prev, cur], 2);
  }
  const ci = span("costIncome");
  if (ci) {
    const [f, l] = [ev("costIncome", ci[0])!, ev("costIncome", ci[1])!];
    if (l.value >= 80 || l.value - f.value >= 5)
      pain("cost-heavy", `Operating costs took ${l.display} of income in FY${ci[1]}, compared with ${f.display} in FY${ci[0]}.`, [f, l], l.value >= 90 ? 3 : 2);
  }
  const nm = span("niiAssets");
  if (nm) {
    const [f, l] = [ev("niiAssets", nm[0])!, ev("niiAssets", nm[1])!];
    if (f.value - l.value >= 0.25)
      pain("margin-squeeze", `Net interest income fell from ${f.display} to ${l.display} of assets between FY${nm[0]} and FY${nm[1]}.`, [f, l], 2);
  }
  const yL = last("loanDepositRatio");
  if (yL !== undefined) {
    const r = ev("loanDepositRatio", yL)!, lg = ev("loanGrowth", yL), dg = ev("depositGrowth", yL);
    if (r.value > 100) pain("funding-gap", `In FY${yL}, loans were ${r.display} of deposits: more was lent out than members had deposited.`, [r], 2);
    else if (lg && dg && lg.value - dg.value >= 5)
      pain("funding-gap", `In FY${yL}, loans grew ${lg.display} while deposits grew ${dg.display}.`, [lg, dg], 1);
  }
  const rc = span("riskCapital");
  const yE = last("equityAssets");
  if (rc && ev("riskCapital", rc[0])!.value - ev("riskCapital", rc[1])!.value >= 1) {
    const [f, l] = [ev("riskCapital", rc[0])!, ev("riskCapital", rc[1])!];
    pain("capital-thinning", `Risk-weighted capital went from ${f.display} in FY${rc[0]} to ${l.display} in FY${rc[1]}.`, [f, l], 2);
  } else if (!rc && !by.has("riskCapital") && yE !== undefined && ev("equityAssets", yE)!.value < 6) {
    // Only when no regulatory capital ratio was reported: equity to assets is not regulatory capital.
    const e = ev("equityAssets", yE)!;
    pain("capital-thinning", `Members' equity (not the regulatory capital ratio) was ${e.display} of assets in FY${yE}.`, [e], 1);
  }
  const yG = last("assetGrowth");
  if (yG !== undefined && ev("assetGrowth", yG)!.value < 2) {
    const g = ev("assetGrowth", yG)!;
    pain("growth-slowing", `Assets ${g.value < 0 ? "shrank" : "grew"} ${pct(Math.abs(g.value))} in FY${yG}.`, [g], g.value < 0 ? 2 : 1);
  }
  const al = span("allowanceRatio");
  if (al) {
    const [f, l] = [ev("allowanceRatio", al[0])!, ev("allowanceRatio", al[1])!];
    if (l.value - f.value >= 0.2)
      pain("credit-reserves", `The loan allowance rose from ${f.display} to ${l.display} of loans between FY${al[0]} and FY${al[1]}.`, [f, l], 1);
  }
  pains.sort((x, y) => y.severity - x.severity || x.rule.localeCompare(y.rule));

  const enough = chapters.length >= 3 && (by.get("assets")?.size ?? 0) >= 3;
  return { years, enough, series, chapters, trends, pains };
}

/** The approval that currently applies to a claim: only one matching the claim's exact hash counts. */
export function approvalFor<T extends { claim_key: string; claim_hash: string; decision: string; decided_at: string | Date }>(
  claim: Claim, decisions: T[]): T | null {
  return decisions.filter((d) => d.claim_key === claim.key && d.claim_hash === claim.hash)
    .sort((x, y) => new Date(y.decided_at).getTime() - new Date(x.decided_at).getTime())[0] ?? null;
}
