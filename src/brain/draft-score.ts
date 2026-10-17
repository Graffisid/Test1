/**
 * analyst — pre-launch scoring of ad-writer's drafts (separation rule: the agent that writes is never
 * the one that checks). A transparent rubric, breakdown always stored. It ranks drafts for the
 * owner's shortlist; the 48-hour live test is what actually decides winners.
 */
import type { Audit } from "./auditor.ts";
import type { AdDraft } from "./schemas.ts";

export interface DraftScore {
  hook: number;
  local: number;
  verified_fact: number;
  cta_fit: number;
  brevity: number;
  novelty: number;
  audit: number;
  total: number;
}

const LOCAL = /\b(burlington|oakville|milton|hamilton|halton)\b/i;
const FACT = /\b(licensed|insured|24\/7|free in-home quote|\$129)\b/i;

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
}

export function similarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

export function scoreDraft(d: AdDraft, audit: Audit, objective: string, existingHeadlines: string[]): DraftScore {
  const hook = /\?$/.test(d.headline.trim()) || /\b(you|your)\b/i.test(d.headline) ? 2 : 0;
  const local = LOCAL.test(`${d.headline} ${d.primary_text}`) ? 2 : 0;
  const verified_fact = FACT.test(`${d.headline} ${d.primary_text}`) ? 2 : 0;
  const cta_fit = objective === "calls" ? (d.cta === "Call now" ? 2 : d.cta === "Get a call back" ? 1 : 0)
    : (["Get a call back", "Get a free quote", "Book now"].includes(d.cta) ? 2 : 0);
  const brevity = d.headline.length <= 60 ? 1 : 0;
  const maxSim = Math.max(0, ...existingHeadlines.map((h) => similarity(h, d.headline)));
  const novelty = maxSim >= 0.6 ? -3 : 1;
  const auditPts = audit.verdict === "flag" ? -2 : 0;
  return { hook, local, verified_fact, cta_fit, brevity, novelty, audit: auditPts,
    total: hook + local + verified_fact + cta_fit + brevity + novelty + auditPts };
}
