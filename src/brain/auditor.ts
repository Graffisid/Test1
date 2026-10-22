/**
 * Compliance pass on every draft, in code, against MUSE.md (the "auditor pass" in the build plan).
 *   reject  → never shown to the owner (banned claims).
 *   flag    → may be shown, marked "unverified claim"; the dashboard won't approve it until the owner
 *             confirms the claim (or edits it out).
 *   pass    → nothing found.
 * Uncertainty means flag, not publish.
 */
import type { BrandRules } from "./muse.ts";
import type { AdDraft } from "./schemas.ts";

export interface Audit {
  verdict: "pass" | "flag" | "reject";
  issues: string[];
}

const OUT_OF_AREA = /\b(toronto|mississauga|brampton|grimsby|niagara|st\.? catharines|guelph)\b/i;

export function auditDraft(d: Pick<AdDraft, "headline" | "primary_text" | "voiceover_script" | "cta">, rules: BrandRules): Audit {
  const text = `${d.headline}\n${d.primary_text}\n${d.voiceover_script}`;
  const lower = text.toLowerCase();
  const rejects: string[] = [];
  const flags: string[] = [];

  for (const banned of rules.bannedClaims) if (lower.includes(banned)) rejects.push(`banned claim "${banned}"`);
  if (/\blowest price\b|\bprice match\b/i.test(text)) rejects.push("price-guarantee claim");
  if (/★|\b\d(\.\d)?[- ]?stars?\b|\brated\b/i.test(text)) rejects.push("star rating / rating claim (invented reviews are banned)");

  for (const m of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{2})?)/g)) {
    const price = `$${m[1].replace(/,/g, "").replace(/\.00$/, "")}`;
    if (!rules.verifiedPrices.includes(price)) flags.push(`unverified price ${price}`);
  }
  if (/\brebate/i.test(text)) flags.push("rebate claim not confirmed by the owner");
  if (/\bguarantee/i.test(text)) flags.push("guarantee claim");
  if (/\b(award|best in|years in business|since 19|since 20)\b/i.test(text)) flags.push("unverified credential claim");
  if (/[“"][^"”]{8,}[”"]/.test(text)) flags.push("quotation — testimonials need written permission");
  if (/\bfree\b(?!\s+(in-home\s+)?quote)/i.test(text)) flags.push('"free" offer other than the verified free in-home quote');
  if (OUT_OF_AREA.test(text)) flags.push("mentions a city outside the service area");
  if (/\b[A-Z]{4,}\b/.test(text.replace(/\bHVAC\b/g, ""))) flags.push("ALL-CAPS shouting (brand voice)");
  if (/!!/.test(text)) flags.push("multiple exclamation marks (brand voice)");
  if (d.headline.length > 80) flags.push("headline over 80 characters");

  const issues = [...rejects, ...flags];
  return { verdict: rejects.length ? "reject" : flags.length ? "flag" : "pass", issues };
}
