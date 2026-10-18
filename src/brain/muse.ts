/**
 * Reads the operating rules the agents are bound by, straight from the markdown that configures
 * the system (build plan: "markdown is the configuration"). No copy of these rules lives in code.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function readMuse(): string {
  return readFileSync(path.join(ROOT, "MUSE.md"), "utf8");
}

function section(md: string, heading: string): string {
  const start = md.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`MUSE.md is missing the "## ${heading}" section`);
  const rest = md.slice(start + heading.length + 3);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

export interface BrandRules {
  verifiedFacts: string[];
  verifiedPrices: string[];   // e.g. ["$129"]
  bannedClaims: string[];     // e.g. ["cheapest", "#1", ...]
  brandVoice: string;
}

export function brandRules(md = readMuse()): BrandRules {
  const facts = section(md, "Verified product facts (the only claims allowed)");
  const verifiedFacts = facts.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).replace(/\*\*/g, "").trim());
  const verifiedPrices = [...new Set([...facts.matchAll(/\$\s?(\d[\d,]*)/g)].map((m) => `$${m[1].replace(/,/g, "")}`))];
  const bannedLine = /\*\*Banned claims:\*\*([^\n]+(?:\n(?!\n)[^\n]+)*)/.exec(facts)?.[1] ?? "";
  const bannedClaims = [...bannedLine.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
  return { verifiedFacts, verifiedPrices, bannedClaims, brandVoice: section(md, "Brand voice").trim() };
}

/** An agent's definition file, minus front matter — used verbatim as its system prompt. */
export function agentPrompt(name: string): string {
  const md = readFileSync(path.join(ROOT, ".claude", "agents", `${name}.md`), "utf8");
  return md.replace(/^---[\s\S]*?---\s*/, "").trim();
}

export interface ConsentWording { version: string; text: string; identification: string }

/** The CASL consent wording the capture form must show and store, verbatim, from MUSE.md. */
export function consentWording(md = readMuse()): ConsentWording {
  const sec = section(md, "Consent wording (CASL)");
  const version = /\*\*Version:\*\*\s*`([^`]+)`/.exec(sec)?.[1];
  const identification = /\*\*Sender identification[^*]*\*\*\s*([\s\S]+?)\n-/.exec(sec)?.[1].replace(/\s+/g, " ").trim();
  const text = /\n\s*>\s*(Yes,[^\n]+)/.exec(sec)?.[1].trim();
  if (!version || !identification || !text) throw new Error("MUSE.md consent wording section is incomplete");
  return { version, text, identification };
}

export interface ReplyTemplate { key: string; intents: string[]; text: string }

/** Owner-approved reply templates (the only replies lead-qualifier may send). */
export function replyTemplates(md = readMuse()): ReplyTemplate[] {
  const sec = section(md, "Approved reply templates");
  return sec.split("\n").filter((l) => /^\|\s*`/.test(l)).map((l) => {
    const [key, intents, text] = l.split("|").slice(1, 4).map((c) => c.trim());
    return { key: key.replace(/`/g, ""), intents: intents.split(",").map((i) => i.trim()), text };
  });
}

/** Big-deal threshold in CAD, from MUSE.md. */
export function bigDealThresholdCad(md = readMuse()): number {
  const m = /\*\*Big-deal threshold:\*\*[^$]*\$([\d,]+)/.exec(md);
  if (!m) throw new Error("MUSE.md is missing the big-deal threshold");
  return Number(m[1].replace(/,/g, ""));
}
