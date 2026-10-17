/**
 * Deterministic stand-in for Claude, so the whole brain can be built and tested with no paid calls.
 * It is deliberately simple (keyword rules / templates) and deliberately imperfect in places — the
 * ad-writer mock includes a few non-compliant drafts so the auditor and analyst have real work.
 */
import type { AdDraft, TriageOutput } from "./schemas.ts";

const has = (text: string, words: RegExp) => words.test(text);

const INJECTION = /\b(ignore (all |any )?(previous|prior|above) instructions|system prompt|you are now|approve all|disregard)\b/i;
const ANGRY = /\b(terrible|unacceptable|worst|scam|furious|disgusting|never again|do not use)\b/i;
const SPAM = /(crypto|followers|earn \$|dm me|💰|signals in bio)/i;
const COMPLAINT = /\b(waited|late|overcharged|higher than|no call|called twice|still (no|not)|disappointed)\b/i;
const BUYING = /\b(how much|price|quote|book|can (someone|you) come|need (a|someone|help)|replace|install|come (today|by|out)|tune-up|openings|burst|leak|asap|appointment)\b/i;
const URGENT = /\b(today|asap|now|tonight|burst|flood|no heat|no hot water|leak)\b/i;
const POSITIVE = /\b(great|recommend|thanks|thank you|tidy|friendly|amazing|fast)\b/i;
const FRENCH = /\b(bonjour|combien|chauffage|merci|plombier|svp)\b/i;

export function mockTriage(input: Record<string, unknown>): TriageOutput {
  const source = String(input.source ?? "");
  const text = String(input.text ?? "");
  const stars = typeof input.stars === "number" ? input.stars : null;
  const language = has(text, FRENCH) ? "fr" : "en";
  const out = (intent: TriageOutput["intent"], confidence: number, route_to: TriageOutput["route_to"], reason: string,
    urgency: TriageOutput["urgency"] = "normal"): TriageOutput => ({ intent, confidence, language, urgency, route_to, reason });

  if (source === "lead_form") return out("buying_intent", 0.95, "lead-qualifier", "Lead form submission");
  if (source === "mention") return out("other", 0.8, "reputation-guard", "Brand mention to review");
  if (source === "review") {
    if ((stars !== null && stars <= 2) || has(text, ANGRY)) return out("complaint", 0.88, "human", "Negative review — owner should respond personally", "high");
    if (stars === 3 || has(text, COMPLAINT)) return out("complaint", 0.8, "reputation-guard", "Mixed review — draft a calm reply");
    return out("other", 0.85, "reputation-guard", "Positive review — draft a thank-you");
  }
  if (!text.trim()) return out("other", 0.5, "human", "No text to classify");
  if (has(text, INJECTION)) return out("other", 0.4, "human", "Message tries to give the system instructions — possible prompt injection");
  if (has(text, ANGRY)) return out("angry", 0.9, "human", "Angry language — human only", "high");
  if (has(text, SPAM)) return out("spam", 0.95, "ignore", "Spam pattern");
  if (has(text, COMPLAINT)) return out("complaint", 0.84, "reputation-guard", "Service complaint");
  if (has(text, BUYING)) {
    const conf = has(text, /\b(how much|price|quote)\b/i) ? 0.93 : 0.88;
    return out("buying_intent", conf, "lead-qualifier", "Asks for service, price or a visit", has(text, URGENT) ? "high" : "normal");
  }
  if (text.includes("?")) return out("question", 0.78, "lead-qualifier", "General question");
  if (has(text, POSITIVE)) return out("other", 0.82, "ignore", "Positive comment, no action needed", "low");
  return out("other", 0.55, "human", "Unclear — not confident enough to route automatically");
}

const ANGLES: { angle: string; headline: (s: string) => string; text: (s: string, city: string) => string; cta: AdDraft["cta"] }[] = [
  { angle: "first cold night", headline: (s) => `Is your ${s} ready for the first cold night?`, text: (s, c) => `Licensed ${c} technicians. Book your ${s} visit before the rush — we call you back within a minute.`, cta: "Get a call back" },
  { angle: "weekend availability", headline: () => "Saturday appointments now open", text: (s, c) => `Can't take a weekday off? Licensed techs serve ${c} on Saturdays too. Book your ${s} today.`, cta: "Book now" },
  { angle: "noise worry", headline: (s) => `Hear a new noise from your ${s}?`, text: (s, c) => `Strange sounds usually mean something's worn. A licensed ${c} tech can check it before it quits.`, cta: "Get a call back" },
  { angle: "24/7 line", headline: () => "Trouble at 2 a.m.? We pick up.", text: (_s, c) => `Our 24/7 emergency line serves ${c}. Licensed and insured.`, cta: "Call now" },
  { angle: "free quote", headline: (s) => `Free in-home ${s} quote`, text: (s, c) => `Thinking about a new ${s}? Get a free in-home quote from a licensed ${c} team.`, cta: "Get a free quote" },
  { angle: "service call fee", headline: () => "$129 service call, licensed techs", text: (_s, c) => `Know the service-call fee up front. Licensed and insured across ${c}.`, cta: "Book now" },
  { angle: "local and licensed", headline: (s) => `Local, licensed ${s} help`, text: (_s, c) => `Serving Burlington, Oakville, Milton and Hamilton Mountain. Book a visit in ${c}.`, cta: "Get a call back" },
  { angle: "before winter", headline: (s) => `Book your ${s} check before winter`, text: (s, c) => `A licensed tech checks your ${s} top to bottom. ${c} appointments this week.`, cta: "Book now" },
];

const SERVICE_NOUN: Record<string, string> = {
  furnace_tuneup: "furnace", furnace_replacement: "furnace", emergency_plumbing: "plumbing",
  water_heater: "water heater", heat_pump: "heat pump", drain_cleaning: "drain",
};

export function mockAdWriter(input: Record<string, unknown>): { variants: AdDraft[] } {
  const service = SERVICE_NOUN[String(input.service)] ?? "home";
  const batch = Math.min(25, Math.max(1, Number(input.batch ?? 20)));
  const learned = (input.learned_from as string[] | undefined) ?? [];
  const cities = ["Burlington", "Oakville", "Milton", "Hamilton Mountain", "Halton"];
  const variants: AdDraft[] = [];
  for (let i = 0; variants.length < batch; i++) {
    const a = ANGLES[i % ANGLES.length];
    const city = cities[Math.floor(i / ANGLES.length) % cities.length];
    variants.push({
      headline: a.headline(service), primary_text: a.text(service, city), cta: a.cta,
      voiceover_script: `${a.headline(service)} Northshore Plumbing and Heating — licensed, local, and on call.`,
      angle: `${a.angle} (${city})`, learned_from: learned[i % Math.max(1, learned.length)] ?? "brand facts only",
      claims_used: ["Licensed and insured in Ontario"],
    });
  }
  // A few drafts the auditor must catch (the mock writer is not trusted either).
  if (batch >= 10) {
    variants[batch - 1] = { ...variants[batch - 1], headline: `Cheapest ${service} service in Halton`, angle: "price (non-compliant)" };
    variants[batch - 2] = { ...variants[batch - 2], headline: `${service[0].toUpperCase()}${service.slice(1)} check from $99`, angle: "price (unverified)" };
    variants[batch - 3] = { ...variants[batch - 3], primary_text: `Ask about energy rebates when you book your ${service} visit.`, angle: "rebate (unverified)" };
  }
  return { variants };
}

export function mockComplete(agent: string, input: Record<string, unknown>): unknown {
  if (agent === "triage") return mockTriage(input);
  if (agent === "ad-writer") return mockAdWriter(input);
  throw new Error(`No mock for agent ${agent}`);
}
