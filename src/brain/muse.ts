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
