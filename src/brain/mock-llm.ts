/**
 * Deterministic stand-in for Claude, so the whole brain can be built and tested with no paid calls.
 * It is deliberately simple (keyword rules / templates) and deliberately imperfect in places — the
 * ad-writer mock includes a few non-compliant drafts so the auditor and analyst have real work.
 */
import type { AdDraft, ContentDraft, ContentPlan, MarketBrief, TriageOutput } from "./schemas.ts";

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

/** A brief built straight from the computed numbers — what a careful analyst would say about them. */
export function mockMarketBrief(input: Record<string, unknown>): MarketBrief {
  const stats = input as { competitors?: { name: string; active_ads: number; learn_from: number; avg_days_running: number;
    longest_running: { days: number; format: string | null } | null }[]; themes?: { theme: string; ads: number }[];
    formats?: Record<string, number>; ours?: { best: { ad: string; cpl: number | null } | null } };
  const comps = stats.competitors ?? [];
  const themes = stats.themes ?? [];
  const top = comps[0];
  const videoHooks = stats.formats?.video_hook ?? 0;
  const total = Object.values(stats.formats ?? {}).reduce((a, b) => a + b, 0) || 1;
  const best = stats.ours?.best;
  return {
    summary: `${comps.length} local competitors are advertising. The ads that keep running ${themes[0] ? `lean on "${themes[0].theme.toLowerCase()}"` : "are simple and local"}`
      + `${videoHooks ? `, and ${Math.round((videoHooks / total) * 100)}% of reviewed ads open with a video hook` : ""}. `
      + `${best ? `Our cheapest leads come from ${best.ad}${best.cpl !== null ? ` at $${best.cpl.toFixed(2)} per lead` : ""}. ` : ""}`
      + "The opening: nobody is explaining warning signs calmly, so show real problems and what a licensed tech checks.",
    what_works: [
      ...(top?.longest_running ? [{ insight: "Long-running ads are simple and seasonal",
        evidence: `${top.name}'s longest ad has run ${top.longest_running.days} days (${top.longest_running.format ?? "format not reviewed"})` }] : []),
      ...themes.slice(0, 2).map((t) => ({ insight: `"${t.theme}" keeps coming back`, evidence: `${t.ads} competitor ads use it` })),
      ...(best ? [{ insight: "Our call-back promise converts", evidence: `${best.ad} is our cheapest source of leads` }] : []),
    ].slice(0, 6).concat(themes.length || top || best ? [] : [{ insight: "Not enough data yet", evidence: "No competitor ads in the period" }]),
    gaps: [
      "Nobody shows what a tune-up actually includes, step by step",
      "Few ads speak to Burlington and Oakville by name",
      "No one answers common questions in a calm, expert voice",
    ],
    angles: [
      { angle: "Three sounds your furnace makes and what they mean", why: "Warning signs recur in long-running ads; we can explain them better", format: "reel" },
      { angle: "What a licensed tech checks in a tune-up", why: "Fills the 'what's included' gap and shows proof (licensed and insured)", format: "carousel" },
      { angle: "Before the first cold night", why: "Seasonal urgency is the most common long-running theme", format: "image_post" },
      { angle: "24/7 emergency line, local crew", why: "Fast response is a verified fact and a proven theme", format: "reel" },
    ],
    avoid: [
      "Price promises and discounts (only the $129 service call is verified)",
      "Fear-based scare tactics — calm expertise performs better for trust",
      "Copying any competitor's wording or format one-for-one",
    ],
    posting_plan: [
      { day: "Tuesday", time: "evening", format: "reel", theme: "Warning signs" },
      { day: "Thursday", time: "morning", format: "carousel", theme: "What a tune-up includes" },
      { day: "Saturday", time: "morning", format: "image_post", theme: "Before the first cold night" },
    ],
  };
}

/** Drafts from the brief — plus one that breaks the rules, so the guardrails visibly earn their keep. */
export function mockContentPlan(input: Record<string, unknown>): ContentPlan {
  const base = { scenes: [], slides: [], visual_brief: "", claims_used: [] } as Pick<ContentDraft, "scenes" | "slides" | "visual_brief" | "claims_used">;
  const items: ContentDraft[] = [
    { ...base, kind: "reel", platform: "instagram", title: "3 furnace sounds you shouldn't ignore",
      hook: "Is your furnace making one of these sounds?",
      scenes: [
        { seconds: 3, shot: "Close-up of a basement furnace panel, warm light", on_screen_text: "Hear this from your furnace?", voiceover: "Is your furnace making one of these sounds?" },
        { seconds: 5, shot: "Tech points at the blower housing", on_screen_text: "1. Rattling at start-up", voiceover: "A rattle when it kicks on can mean a loose panel or blower part." },
        { seconds: 5, shot: "Tech checks the burner area with a flashlight", on_screen_text: "2. A loud bang", voiceover: "A bang at ignition is worth a look before the cold sets in." },
        { seconds: 5, shot: "Tech listens near the motor", on_screen_text: "3. High-pitched squeal", voiceover: "A squeal often points to a belt or motor bearing." },
        { seconds: 6, shot: "Tech closes the panel and smiles at camera in a Burlington home", on_screen_text: "Licensed. Insured. Local.", voiceover: "Licensed and insured techs in Burlington and Oakville. Tap to get a call back." },
      ],
      caption: "Furnaces usually warn you before they quit. If you're hearing a rattle, a bang or a squeal, a licensed Northshore tech can take a look. Serving Burlington, Oakville, Hamilton Mountain and Milton. Tap to get a call back.",
      hashtags: ["#Burlington", "#Oakville", "#FurnaceTuneUp", "#HomeMaintenance", "#OntarioHomes"], cta: "Get a call back",
      angle: "Warning signs", why_it_should_work: "Names a problem people can hear right now, in the first 3 seconds, and answers it calmly with proof.",
      posting_day: "Tuesday", posting_time: "evening" },
    { ...base, kind: "carousel", platform: "instagram", title: "What a licensed tech checks in a tune-up",
      hook: "Ever wondered what a furnace tune-up actually covers?",
      slides: [
        { headline: "What's in a tune-up?", body: "Here's what a licensed Northshore tech checks, step by step." },
        { headline: "Filter and airflow", body: "A clogged filter makes your furnace work harder." },
        { headline: "Burners and ignition", body: "Clean, steady ignition means fewer surprises." },
        { headline: "Blower and motor", body: "We listen for wear before it becomes a breakdown." },
        { headline: "Safety checks", body: "Venting and controls, checked by a licensed tech." },
        { headline: "Book yours", body: "Serving Burlington, Oakville, Hamilton Mountain and Milton. Get a call back." },
      ],
      visual_brief: "Clean, bright cover photo of a furnace with a technician's gloved hand holding a new filter; brand colours, no text overlay beyond the title.",
      caption: "Swipe to see what a licensed tech checks in a furnace tune-up. Licensed and insured, serving Burlington, Oakville, Hamilton Mountain and Milton. Tap to get a call back.",
      hashtags: ["#FurnaceTuneUp", "#Burlington", "#HomeTips", "#Heating"], cta: "Get a call back",
      angle: "What's included", why_it_should_work: "Fills the 'what's included' gap; carousels earn saves and shares.",
      posting_day: "Thursday", posting_time: "morning" },
    { ...base, kind: "image_post", platform: "facebook", title: "Before the first cold night",
      hook: "Is your furnace ready for the first cold night?",
      visual_brief: "A cozy Burlington living room at dusk, frost on the window, a thermostat glowing at 21 °C; warm, natural light; no people's faces.",
      caption: "Is your furnace ready for the first cold night? A quick check by a licensed Northshore tech now beats a no-heat call later. Free in-home quotes for furnace and heat-pump replacements. Tap to get a call back.",
      hashtags: ["#Burlington", "#Oakville", "#FallMaintenance", "#Heating"], cta: "Get a call back",
      angle: "Seasonal urgency", why_it_should_work: "Seasonal urgency is the most common long-running theme; local and calm.",
      posting_day: "Saturday", posting_time: "morning" },
    { ...base, kind: "reel", platform: "instagram", title: "24/7 emergency line",
      hook: "Burst pipe at 2 a.m.?",
      scenes: [
        { seconds: 3, shot: "Phone lighting up on a nightstand at night", on_screen_text: "Burst pipe at 2 a.m.?", voiceover: "Burst pipe at 2 a.m.?" },
        { seconds: 5, shot: "Northshore van pulling into a driveway", on_screen_text: "24/7 emergency line", voiceover: "Our emergency line is open 24/7." },
        { seconds: 6, shot: "Tech shutting off a water valve calmly", on_screen_text: "Licensed and insured", voiceover: "A licensed, insured local crew, serving Burlington and Oakville." },
        { seconds: 4, shot: "Tech wiping hands, giving a thumbs up", on_screen_text: "Call (905) 555-0100", voiceover: "Save our number: (905) 555-0100." },
      ],
      caption: "Plumbing emergencies don't wait for business hours, and neither do we. 24/7 emergency line, licensed and insured, serving Burlington, Oakville, Hamilton Mountain and Milton. Call now.",
      hashtags: ["#Burlington", "#EmergencyPlumber", "#Oakville"], cta: "Call now",
      angle: "Fast response", why_it_should_work: "A verified, proven theme; the hook is a moment everyone fears.",
      posting_day: "Wednesday", posting_time: "evening" },
    // Deliberately non-compliant: banned claim, unverified price, shouting, a link. The guardrails must drop it.
    { ...base, kind: "image_post", platform: "facebook", title: "Cheapest tune-up deal",
      hook: "CHEAPEST furnace tune-up in Halton!!",
      visual_brief: "Big red sale banner over a furnace photo with a starburst graphic.",
      caption: "Tune-ups from $79 this week only. Book at www.example-deals.com",
      hashtags: ["#Deal"], cta: "Book now", angle: "Price", why_it_should_work: "Discounts get clicks.",
      posting_day: "Friday", posting_time: "morning" },
  ];
  const batch = Number(input.batch) || items.length;
  return { items: items.slice(0, Math.max(1, batch)) };
}

export function mockComplete(agent: string, input: Record<string, unknown>): unknown {
  if (agent === "triage") return mockTriage(input);
  if (agent === "ad-writer") return mockAdWriter(input);
  if (agent === "market-analyst") return mockMarketBrief(input);
  if (agent === "content-writer") return mockContentPlan(input);
  throw new Error(`No mock for agent ${agent}`);
}
