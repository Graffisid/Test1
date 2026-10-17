/**
 * Seeds realistic MOCK data for the fictional Northshore Plumbing & Heating
 * (Burlington, Ontario). 30 days of history ending now, plus a live approvals queue.
 *
 * - Deterministic shape: a seeded PRNG drives every random choice, and dates are
 *   relative to "now", so the dashboard always has a yesterday and a today.
 * - Every row in the attribution chain is linked by foreign key:
 *   ad → comment → lead → call → appointment → paid.
 * - Everything external is simulated (calls.is_simulated = true). No real
 *   people, numbers (555-01xx), or emails (example.com).
 *
 *   npm run db:seed
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { databaseUrl, newClient } from "../src/lib/db.ts";
import { classifyVariant, type VariantCycleStats } from "../src/lib/classify.ts";

// ---------------------------------------------------------------------------
// Deterministic randomness + Toronto-time helpers
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = mulberry32(20261017);
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const int = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));
const chance = (p: number) => rand() < p;
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const round2 = (n: number) => Math.round(n * 100) / 100;
function poisson(lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}

const TZ = "America/Toronto";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function tzOffsetMs(instant: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}
function torontoDateString(instant: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(instant));
}
/** Instant for HH:MM Toronto time on the Toronto date `daysAgo` days before now. */
function torontoAt(daysAgo: number, hours: number, minutes = 0): Date {
  const [y, m, d] = torontoDateString(NOW - daysAgo * DAY).split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hours, minutes);
  return new Date(guess - tzOffsetMs(guess));
}
const at = (ms: number) => new Date(ms);

const NOW = Date.now();
const HISTORY_DAYS = 30;
const OWNER = "Dana Reyes";
const SALES_LEAD = "Sam Okafor";

// ---------------------------------------------------------------------------
// Business definition (fictional)
// ---------------------------------------------------------------------------

type Service =
  | "furnace_tuneup" | "furnace_replacement" | "emergency_plumbing"
  | "water_heater" | "heat_pump" | "drain_cleaning";

const JOB_VALUE: Record<Service, [number, number]> = {
  furnace_tuneup: [149, 229],
  furnace_replacement: [5200, 8800],
  emergency_plumbing: [180, 650],
  water_heater: [1900, 3400],
  heat_pump: [6500, 11000],
  drain_cleaning: [160, 380],
};
const SERVICE_LABEL: Record<Service, string> = {
  furnace_tuneup: "Furnace tune-up",
  furnace_replacement: "Furnace replacement",
  emergency_plumbing: "Emergency plumbing",
  water_heater: "Water heater replacement",
  heat_pump: "Heat pump install",
  drain_cleaning: "Drain cleaning",
};
const BIG_DEAL_CAD = 5000; // MUSE.md big-deal threshold

interface VariantDef {
  label: string;
  headline: string;
  primaryText: string;
  cta: string;
  voiceover: string;
  liveFrom?: number; // days ago
  liveUntil?: number; // days ago (exclusive); undefined = still live
  trueCpl?: (daysAgo: number) => number;
  fate?: "killed" | "platform_rejected" | "owner_rejected";
  rejectNote?: string;
}
interface AdDef {
  key: string;
  platform: "meta" | "tiktok";
  name: string;
  service: Service;
  objective: "leads" | "calls";
  dailyBudget: number;
  targetCpl: number;
  launchedDaysAgo?: number;
  pausedDaysAgo?: number;
  pausedReason?: string;
  status: "live" | "paused" | "draft";
  variants: VariantDef[];
}

const ADS: AdDef[] = [
  {
    key: "A1", platform: "meta", name: "Furnace Tune-Up — Fall 2026", service: "furnace_tuneup",
    objective: "leads", dailyBudget: 20, targetCpl: 35, launchedDaysAgo: 28, status: "live",
    variants: [
      { label: "A", headline: "Is your furnace ready for the first cold night?",
        primaryText: "Licensed Burlington technicians. Book a fall tune-up before the rush — we'll call you back within a minute.",
        cta: "Get a call back", voiceover: "First cold night coming? Book your furnace tune-up with Northshore. We call you back in under a minute.",
        liveFrom: 28, trueCpl: () => 12 },
      { label: "B", headline: "Fall furnace tune-ups in Halton",
        primaryText: "Serving Burlington, Oakville, Milton and Hamilton Mountain. Licensed and insured.",
        cta: "Book now", voiceover: "Northshore Plumbing and Heating. Fall tune-ups across Halton. Licensed and insured.",
        liveFrom: 28, trueCpl: () => 38 },
      { label: "C", headline: "Don't freeze this winter!",
        primaryText: "Furnaces fail when you need them most. Act now.",
        cta: "Learn more", voiceover: "Don't freeze this winter. Call Northshore.",
        liveFrom: 28, liveUntil: 14, trueCpl: () => 95, fate: "killed" },
      { label: "D", headline: "Tune-up now, sleep warm all winter",
        primaryText: "A licensed tech checks your furnace top to bottom. 24/7 emergency line if anything goes wrong.",
        cta: "Get a call back", voiceover: "Tune up now and sleep warm all winter. Northshore — licensed, local, and on call 24/7.",
        liveFrom: 12, trueCpl: () => 18 },
    ],
  },
  {
    key: "A2", platform: "meta", name: "24/7 Emergency Plumbing — Burlington", service: "emergency_plumbing",
    objective: "calls", dailyBudget: 18, targetCpl: 40, launchedDaysAgo: 30, status: "live",
    variants: [
      { label: "A", headline: "Burst pipe at 2 a.m.? We pick up.",
        primaryText: "24/7 emergency plumbing in Burlington, Oakville, Milton and Hamilton Mountain. $129 service call.",
        cta: "Call now", voiceover: "Burst pipe at two in the morning? Northshore picks up. Twenty-four seven.",
        liveFrom: 30, trueCpl: () => 14 },
      { label: "B", headline: "Licensed plumbers on call tonight",
        primaryText: "Leaks, clogs, no hot water — a licensed Northshore plumber is on call right now.",
        cta: "Get a call back", voiceover: "Leaks, clogs, no hot water? A licensed Northshore plumber is on call tonight.",
        liveFrom: 16, trueCpl: () => 38 },
      { label: "C", headline: "Flooded basement? Before & after",
        primaryText: "See what we did for a Burlington basement last week.",
        cta: "Learn more", voiceover: "Flooded basement? Watch what Northshore did last week.",
        fate: "platform_rejected", rejectNote: "Meta: before/after imagery policy" },
    ],
  },
  {
    key: "A3", platform: "meta", name: "Water Heater Replacement — Free Quote", service: "water_heater",
    objective: "leads", dailyBudget: 14, targetCpl: 55, launchedDaysAgo: 20, status: "live",
    variants: [
      { label: "A", headline: "Cold shower again? Free in-home water heater quote",
        primaryText: "Tank or tankless. A licensed Northshore tech gives you a free in-home quote.",
        cta: "Get a free quote", voiceover: "Cold shower again? Get a free in-home water heater quote from Northshore.",
        liveFrom: 20, trueCpl: () => 30 },
      { label: "B", headline: "Water heater over 10 years old?",
        primaryText: "Most tanks start failing after a decade. Book a free in-home quote.",
        cta: "Get a free quote", voiceover: "Is your water heater over ten years old? Book a free quote with Northshore.",
        liveFrom: 20, trueCpl: () => 58 },
      { label: "X", headline: "Cheapest water heaters in Halton!",
        primaryText: "Lowest price guaranteed or we'll match it.",
        cta: "Get a quote", voiceover: "The cheapest water heaters in Halton.",
        fate: "owner_rejected", rejectNote: "Banned claim: 'cheapest' / 'lowest price guaranteed' (MUSE.md)" },
    ],
  },
  {
    key: "A4", platform: "meta", name: "Heat Pump Quotes — Halton", service: "heat_pump",
    objective: "leads", dailyBudget: 12, targetCpl: 90, launchedDaysAgo: 18, pausedDaysAgo: 5,
    pausedReason: "Interrupt: cost per lead jumped >50% above 7-day average", status: "paused",
    variants: [
      { label: "A", headline: "Thinking about a heat pump?",
        primaryText: "Free in-home heat pump quote from licensed Halton installers.",
        cta: "Get a free quote", voiceover: "Thinking about a heat pump? Get a free in-home quote from Northshore.",
        liveFrom: 18, liveUntil: 5, trueCpl: (d) => (d > 10 ? 45 : 130) },
      { label: "B", headline: "Heat and cool with one system",
        primaryText: "Heat pumps heat in winter and cool in summer. Book a free quote.",
        cta: "Get a free quote", voiceover: "One system for heating and cooling. Book a free heat pump quote.",
        liveFrom: 18, liveUntil: 5, trueCpl: (d) => (d > 10 ? 55 : 150) },
    ],
  },
  {
    key: "A5", platform: "tiktok", name: "Drain Cleaning — TikTok test", service: "drain_cleaning",
    objective: "leads", dailyBudget: 0, targetCpl: 35, status: "draft",
    variants: [
      { label: "A", headline: "What we pulled out of this drain 😳",
        primaryText: "Slow drain? Northshore clears it. Burlington, Oakville, Milton, Hamilton Mountain.",
        cta: "Get a call back", voiceover: "You won't believe what was in this drain. Slow drain? Call Northshore." },
    ],
  },
];

const FIRST = ["Priya", "Liam", "Olivia", "Noah", "Emma", "Mohammed", "Chloé", "Lucas", "Aisha", "Ethan", "Mei",
  "Jacob", "Sofia", "Daniel", "Hannah", "Arjun", "Grace", "Mateo", "Leah", "Owen", "Fatima", "Ryan", "Zoe", "Wei",
  "Isabelle", "Marcus", "Nadia", "Tyler", "Amara", "Connor"];
const LAST = ["Patel", "Nguyen", "MacDonald", "Singh", "Tremblay", "Li", "Wilson", "Ahmed", "Martin", "Brown",
  "Kowalski", "Chen", "O'Brien", "Gagnon", "Silva", "Campbell", "Haddad", "Roy", "Thompson", "Kim"];
const CITIES = ["Burlington", "Burlington", "Burlington", "Oakville", "Oakville", "Hamilton", "Milton"] as const;

const BUYING: Record<Service, string[]> = {
  furnace_tuneup: ["How much for a tune-up?", "Can someone come this week? Furnace is making a clicking noise",
    "Do you do tune-ups in Oakville?", "Need a tune-up before winter, do you have openings?"],
  furnace_replacement: ["Our furnace is 22 years old, think it's time. Can I get a quote?",
    "Furnace died last night, need a replacement quote"],
  emergency_plumbing: ["Pipe burst under the sink, can someone come now?", "Basement drain backing up, need help ASAP",
    "Is the $129 service call still on? Toilet won't stop running", "No water pressure upstairs, can you come today?"],
  water_heater: ["Our tank is leaking, how fast can you replace it?", "Quote for tankless please",
    "Water heater is 12 years old, want a quote"],
  heat_pump: ["Interested in a heat pump, can I get a quote?", "Do you install cold-climate heat pumps?"],
  drain_cleaning: ["Kitchen drain is super slow, can you come by?"],
};
const QUESTIONS = ["Are you open Sundays?", "Do you do commercial buildings?", "How long does a tune-up take?",
  "Do you install tankless?", "Do you service Grimsby?"];
const POSITIVE = ["Sam was great, fixed our sump pump in an hour 👍", "Used them last winter, highly recommend",
  "Fast and tidy, thanks Northshore!", "Great service on our water heater"];
const COMPLAINTS = ["Waited 3 hours past my window last month", "Invoice was higher than the phone estimate",
  "Had to call twice to get someone out"];
const SPAM = ["Earn $5000/week from home 💰 DM me", "Check my page for cheap followers!!", "🔥🔥 crypto signals in bio"];
const ANGRY = ["Your tech left a mess and nobody called me back. Terrible.",
  "Still no hot water after you 'fixed' it. Unacceptable.", "Worst service I've had. Do NOT use these guys."];
const AMBIGUOUS = ["hmm 🤔", "lol my landlord needs to see this", "@mike_b"];

const CONSENT_TEXT =
  "Yes, Northshore Plumbing & Heating may call or text me at this number about my request. " +
  "I can opt out anytime by replying STOP or asking to be removed.";
const CAPTURE_TEMPLATE =
  "Thanks for reaching out! Pop your number in here and a Northshore team member will call you within a minute: https://northshore.example/quote";

// ---------------------------------------------------------------------------
// Insert helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const rows: Record<string, Row[]> = {
  ads: [], ad_variants: [], signals: [], customers: [], comments: [], leads: [], calls: [],
  appointments: [], approvals: [], metrics: [], agent_activity_log: [],
};
const INSERT_ORDER = Object.keys(rows);

function log(entry: {
  at: Date; agent: string; department?: string; action: string; decision?: string;
  status?: string; entityType?: string; entityId?: string; approvalId?: string;
  cost?: number; latency?: number; details?: Row; key?: string;
}) {
  rows.agent_activity_log.push({
    id: randomUUID(), occurred_at: entry.at, agent: entry.agent, department: entry.department ?? null,
    action: entry.action, decision: entry.decision ?? null, status: entry.status ?? "ok",
    entity_type: entry.entityType ?? null, entity_id: entry.entityId ?? null,
    approval_id: entry.approvalId ?? null, est_cost_cad: entry.cost ?? 0, latency_ms: entry.latency ?? null,
    details: JSON.stringify(entry.details ?? {}), idempotency_key: entry.key ?? null,
    created_at: entry.at, updated_at: entry.at,
  });
}

async function insertAll(client: pg.Client) {
  for (const table of INSERT_ORDER) {
    const list = rows[table];
    if (!list.length) continue;
    const cols = Object.keys(list[0]);
    // Batch to stay well under Postgres' 65535-parameter limit.
    const batchSize = Math.floor(30000 / cols.length);
    for (let i = 0; i < list.length; i += batchSize) {
      const batch = list.slice(i, i + batchSize);
      const params: unknown[] = [];
      const tuples = batch.map((r) => {
        const ph = cols.map((c) => {
          params.push(r[c] === undefined ? null : r[c]);
          return `$${params.length}`;
        });
        return `(${ph.join(",")})`;
      });
      await client.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${tuples.join(",")}`, params);
    }
  }
}

// ---------------------------------------------------------------------------
// Build the dataset
// ---------------------------------------------------------------------------

function build() {
  rand = mulberry32(20261017);
  for (const k of Object.keys(rows)) rows[k] = [];
  latestVerdict.clear();

  const adIds = new Map<string, string>();
  const variantIds = new Map<string, string>(); // "A1:B" -> id
  const isLive = (v: VariantDef, d: number) =>
    v.liveFrom !== undefined && d <= v.liveFrom && (v.liveUntil === undefined || d >= v.liveUntil);

  // ---- ads, variants, and the approvals that let them go live --------------
  for (const ad of ADS) {
    const adId = randomUUID();
    adIds.set(ad.key, adId);
    const created = ad.launchedDaysAgo !== undefined ? torontoAt(ad.launchedDaysAgo + 2, 10) : torontoAt(1, 15);
    const launched = ad.launchedDaysAgo !== undefined ? torontoAt(ad.launchedDaysAgo, 9) : null;
    rows.ads.push({
      id: adId, platform: ad.platform, name: ad.name, objective: ad.objective, service: ad.service,
      status: ad.status, daily_budget_cad: ad.status === "paused" ? 0 : ad.dailyBudget, target_cpl_cad: ad.targetCpl,
      platform_ad_id: launched ? `mock_meta_${ad.key.toLowerCase()}_${int(100000, 999999)}` : null,
      launched_at: launched, paused_reason: ad.pausedReason ?? null,
      idempotency_key: launched ? `launch:${adId}` : null, created_at: created, updated_at: created,
    });
    if (launched) {
      const apId = randomUUID();
      const decided = at(launched.getTime() - int(2, 18) * HOUR);
      rows.approvals.push({
        id: apId, kind: "ad_launch", ad_id: adId, ad_variant_id: null, title: `Launch: ${ad.name}`,
        summary: `$${ad.dailyBudget}/day on ${ad.platform}. Weekly cap $500 checked in code.`,
        payload: JSON.stringify({ daily_budget_cad: ad.dailyBudget, target_cpl_cad: ad.targetCpl }),
        original_payload: null, requested_by_agent: "growth-director", status: "approved", edited: false,
        edited_by: null, edited_at: null, decided_by: OWNER, decided_at: decided, decision_note: null,
        expires_at: at(created.getTime() + 2 * DAY), spend_delta_cad: ad.dailyBudget,
        idempotency_key: `approval:ad_launch:${adId}`, created_at: created, updated_at: decided,
      });
      log({ at: decided, agent: "owner", department: "publishing", action: "approve", decision: `Approved launch of "${ad.name}"`,
        entityType: "approval", entityId: apId, approvalId: apId });
      log({ at: launched, agent: "system", department: "paid_ads", action: "launch_ad",
        decision: `Launched "${ad.name}" at $${ad.dailyBudget}/day (simulated; spend-cap check passed)`,
        entityType: "ad", entityId: adId, approvalId: apId, key: `log:launch:${adId}` });
    }

    for (const v of ad.variants) {
      const vId = randomUUID();
      variantIds.set(`${ad.key}:${v.label}`, vId);
      const draftedAt = v.liveFrom !== undefined ? torontoAt(v.liveFrom + 2, 8, 30) : torontoAt(int(6, 12), 8, 30);
      let status: string = "draft";
      let publishedAt: Date | null = null;
      if (v.liveFrom !== undefined) {
        publishedAt = torontoAt(v.liveFrom, 9, 5);
        status = ad.status === "paused" ? "paused" : v.liveUntil === undefined ? "live" : "killed";
      } else if (v.fate === "platform_rejected" || v.fate === "owner_rejected") {
        status = "rejected";
      }
      rows.ad_variants.push({
        id: vId, ad_id: adId, label: v.label, headline: v.headline, primary_text: v.primaryText, cta: v.cta,
        voiceover_script: v.voiceover,
        video_url: v.liveFrom !== undefined ? `mock://assets/${ad.key.toLowerCase()}-${v.label.toLowerCase()}.mp4` : null,
        voiceover_url: v.liveFrom !== undefined ? `mock://assets/${ad.key.toLowerCase()}-${v.label.toLowerCase()}-vo.mp3` : null,
        status, classification: null, score_breakdown: null, needs_fact_check: false, created_by_agent: "ad-writer",
        published_at: publishedAt, idempotency_key: publishedAt ? `publish:${vId}` : null,
        created_at: draftedAt, updated_at: publishedAt ?? draftedAt,
      });
      log({ at: draftedAt, agent: "ad-writer", department: "content_studio", action: "draft_variant",
        decision: `Drafted ${ad.key}-${v.label}: "${v.headline}"`, entityType: "ad_variant", entityId: vId,
        cost: 0.018, latency: int(4000, 9000) });
      if (ad.status === "draft") {
        // TikTok is parked until Meta is proven (build plan Section 4). The draft was never decided,
        // so it expired — demonstrating that silence is never an approval.
        const apId = randomUUID();
        const expires = at(draftedAt.getTime() + 2 * DAY);
        rows.approvals.push({
          id: apId, kind: "ad_variant", ad_id: adId, ad_variant_id: vId, title: `${ad.name} — variant ${v.label}`,
          summary: v.headline, payload: JSON.stringify({ headline: v.headline, primary_text: v.primaryText, cta: v.cta }),
          original_payload: null, requested_by_agent: "ad-writer", status: "expired", edited: false, edited_by: null,
          edited_at: null, decided_by: null, decided_at: null, decision_note: "No decision within 48h — expired, nothing published.",
          expires_at: expires, spend_delta_cad: null, idempotency_key: `approval:ad_variant:${vId}`, created_at: draftedAt, updated_at: expires,
        });
        log({ at: expires, agent: "system", department: "publishing", action: "approval_expired",
          decision: `${ad.key}-${v.label} expired after 48h with no decision — not published`, entityType: "approval", entityId: apId, approvalId: apId });
        continue;
      }

      // The owner's decision on the draft.
      const apId = randomUUID();
      const decidedAt = at(draftedAt.getTime() + int(1, 20) * HOUR);
      const approved = v.fate !== "owner_rejected";
      rows.approvals.push({
        id: apId, kind: "ad_variant", ad_id: adId, ad_variant_id: vId, title: `${ad.name} — variant ${v.label}`,
        summary: v.headline, payload: JSON.stringify({ headline: v.headline, primary_text: v.primaryText, cta: v.cta, voiceover_script: v.voiceover }),
        original_payload: null, requested_by_agent: "ad-writer", status: approved ? "approved" : "rejected", edited: false,
        edited_by: null, edited_at: null, decided_by: OWNER, decided_at: decidedAt,
        decision_note: approved ? null : v.rejectNote ?? null, expires_at: at(draftedAt.getTime() + 2 * DAY),
        spend_delta_cad: null, idempotency_key: `approval:ad_variant:${vId}`, created_at: draftedAt, updated_at: decidedAt,
      });
      log({ at: decidedAt, agent: "owner", department: "publishing", action: approved ? "approve" : "reject",
        decision: `${approved ? "Approved" : "Rejected"} ${ad.key}-${v.label}${v.rejectNote ? ` — ${v.rejectNote}` : ""}`,
        entityType: "approval", entityId: apId, approvalId: apId });
      if (publishedAt) {
        log({ at: publishedAt, agent: "system", department: "publishing", action: "publish_variant",
          decision: `Published ${ad.key}-${v.label} (simulated)`, entityType: "ad_variant", entityId: vId,
          approvalId: apId, key: `log:publish:${vId}` });
        log({ at: at(publishedAt.getTime() - 3 * HOUR), agent: "media-producer", department: "content_studio",
          action: "generate_assets", decision: `Video + voiceover for ${ad.key}-${v.label} (simulated, no credits used)`,
          entityType: "ad_variant", entityId: vId, cost: 0, latency: int(20000, 60000) });
      }
      if (v.fate === "platform_rejected") {
        const t = torontoAt(9, 11, 20);
        log({ at: at(t.getTime() - 40 * MIN), agent: "system", department: "publishing", action: "submit_variant",
          decision: `Submitted ${ad.key}-${v.label} to Meta review (simulated)`, entityType: "ad_variant", entityId: vId, approvalId: apId,
          key: `log:submit:${vId}` });
        log({ at: t, agent: "growth-director", department: "orchestration", action: "interrupt", status: "interrupt",
          decision: `Ad rejected by platform — ${v.rejectNote}. Paused this variant's thread only; recommend rewriting without before/after imagery.`,
          entityType: "ad_variant", entityId: vId, details: { trigger: "ad_rejected_by_platform" } });
      }
    }
  }

  // ---- competitor ads from the Ad Library poller (Market Intelligence) -----
  const COMPETITORS = ["Lakeshore Comfort Heating", "Halton Drain Pros", "Escarpment HVAC", "Bayview Plumbing Co."];
  for (let i = 0; i < 24; i++) {
    const advertiser = COMPETITORS[i % COMPETITORS.length];
    const firstSeenDaysAgo = int(1, 60);
    const active = chance(0.65);
    const lastSeenDaysAgo = active ? 0 : int(0, Math.max(0, firstSeenDaysAgo - 1));
    const days = firstSeenDaysAgo - lastSeenDaysAgo;
    const variantsOfConcept = int(1, 5);
    const isVideo = chance(0.5);
    const hook = isVideo && chance(0.6);
    const hasOffer = chance(0.75);
    const longevity = days >= 30 ? 5 : days >= 14 ? 3 : days >= 3 ? 1 : 0;
    const persistence = active ? 2 : days < 7 ? -2 : 0;
    const variantPts = variantsOfConcept >= 3 ? 2 : 0;
    const format = (hook ? 1 : 0) + (hasOffer ? 0 : -1);
    const total = longevity + persistence + variantPts + format;
    const verdict = total >= 7 ? "learn_from" : total >= 4 ? "watchlist" : "ignore";
    const concept = pick(["fall tune-up special", "furnace financing", "emergency plumber 24/7", "drain camera inspection",
      "heat pump rebate explainer", "water heater same-day install", "customer testimonial video"]);
    const id = randomUUID();
    const polledAt = torontoAt(0, 2, 0);
    const extId = `mock_adlib_${100000 + i}`;
    rows.signals.push({
      id, source: "ad_library", external_id: extId, received_at: at(Math.min(polledAt.getTime(), NOW - 5 * MIN)),
      payload: JSON.stringify({ advertiser, concept, first_seen: torontoDateString(NOW - firstSeenDaysAgo * DAY),
        last_seen: torontoDateString(NOW - lastSeenDaysAgo * DAY), active, format: isVideo ? "video" : "static",
        variants_of_concept: variantsOfConcept,
        score: { longevity, persistence, variant_count: variantPts, format, total, verdict } }),
      classification: null, intent: null, confidence: null, route_to: "analyst", processed_at: polledAt,
      idempotency_key: `adlib:${extId}`, created_at: polledAt, updated_at: polledAt,
    });
    // A brand-new competitor ad triggers the "competitor launches something new" interrupt.
    if (firstSeenDaysAgo === 1 || i === 7) {
      log({ at: at(Math.min(polledAt.getTime() + 2 * MIN, NOW - 4 * MIN)), agent: "growth-director", department: "market_intelligence",
        action: "interrupt", status: "interrupt", entityType: "signal", entityId: id,
        decision: `Competitor launched something new: ${advertiser} — "${concept}". Notified owner; no action taken automatically.`,
        details: { trigger: "competitor_launch" } });
    }
  }
  log({ at: at(Math.min(torontoAt(0, 2, 1).getTime(), NOW - 4 * MIN)), agent: "analyst", department: "market_intelligence",
    action: "score_competitor_ads", decision: "Scored 24 competitor ads with the longevity rubric (simulated Ad Library poll)",
    cost: 0.012, latency: 5400 });

  // ---- daily loop: spend → comments → leads → calls → appointments --------
  const variantDaily = new Map<string, { day: number; spend: number; leads: number }[]>();
  let interruptLoggedAngry = false;
  let interruptAskedHuman = 0;

  for (let d = HISTORY_DAYS; d >= 0; d--) {
    const isToday = d === 0;
    const dayStart = torontoAt(d, 0).getTime();
    const dayEnd = isToday ? NOW - 20 * MIN : torontoAt(d, 23, 59).getTime();
    const dayLen = dayEnd - dayStart;
    if (dayLen <= 0) continue;
    // Activity happens mostly 7:00–22:00; for today, only up to now.
    const randomTime = () => {
      const lo = dayStart + 7 * HOUR;
      const hi = Math.max(lo + MIN, Math.min(dayEnd, dayStart + 22 * HOUR));
      return Math.min(dayEnd, Math.floor(between(lo, hi)));
    };

    for (const ad of ADS) {
      if (ad.status === "draft") continue;
      const live = ad.variants.filter((v) => isLive(v, d));
      if (!live.length) continue;
      for (const v of live) {
        const vId = variantIds.get(`${ad.key}:${v.label}`)!;
        // Metrics are posted the next morning, so there is no metrics row for today.
        let spend = 0;
        if (!isToday) {
          spend = round2(Math.min(40, (ad.dailyBudget / live.length) * between(0.85, 1.05)));
          const impressions = Math.round((spend / between(10, 15)) * 1000);
          const clicks = Math.round(impressions * between(0.008, 0.016));
          rows.metrics.push({
            id: randomUUID(), metric_date: torontoDateString(dayStart + 12 * HOUR), ad_id: adIds.get(ad.key),
            ad_variant_id: vId, spend_cad: spend, impressions, clicks, platform_leads: 0,
            created_at: torontoAt(d - 1, 6), updated_at: torontoAt(d - 1, 6),
          });
        }
        const expectedLeads = isToday ? (ad.dailyBudget / live.length / v.trueCpl!(d)) * 0.25 : spend / v.trueCpl!(d);
        const nLeads = poisson(expectedLeads);
        const hist = variantDaily.get(vId) ?? [];
        hist.push({ day: d, spend, leads: nLeads });
        variantDaily.set(vId, hist);
        if (!isToday) rows.metrics[rows.metrics.length - 1].platform_leads = nLeads;

        for (let i = 0; i < nLeads; i++) {
          let service = ad.service;
          if (ad.service === "furnace_tuneup" && chance(0.1)) service = "furnace_replacement";
          createLead({ t: randomTime(), adKey: ad.key, adId: adIds.get(ad.key)!, variantId: vId, service, isToday });
        }

        // Non-lead engagement on this ad: questions, praise, complaints, spam, the odd angry one.
        const nOther = poisson(isToday ? 0.3 : 0.9);
        for (let i = 0; i < nOther; i++) {
          createOtherComment({ t: randomTime(), adId: adIds.get(ad.key)!, variantId: vId, d });
        }
      }
    }

    // Organic / unattributed leads (DMs and the website form) — reported as "unknown source".
    const nOrganic = poisson(isToday ? 0.1 : 0.35);
    for (let i = 0; i < nOrganic; i++) {
      createLead({ t: randomTime(), adKey: null, adId: null, variantId: null,
        service: pick(["emergency_plumbing", "drain_cleaning", "water_heater", "furnace_tuneup"] as Service[]), isToday });
    }

    // Reviews and mentions roughly every few days.
    if (!isToday && chance(0.3)) createReview(randomTime());

    // Morning digest at 07:00 summarises the previous day.
    const digestAt = torontoAt(d, 7).getTime();
    if (digestAt < NOW && d < HISTORY_DAYS) {
      log({ at: at(digestAt), agent: "growth-director", department: "orchestration", action: "morning_digest",
        decision: `Assembled morning digest for ${torontoDateString(digestAt - 12 * HOUR)}`, cost: 0.006, latency: int(2500, 6000),
        key: `digest:${torontoDateString(digestAt - 12 * HOUR)}` });
    }

    // 48-hour ad cycle: analyst classifies every live variant, proposes reallocation for owner approval.
    if (!isToday && d % 2 === 0 && d < 28) runCycle(d);
  }

  // Guarantee the "angry comment spreading" interrupt is represented in the last few days.
  if (!interruptLoggedAngry) {
    createOtherComment({ t: torontoAt(1, 19, 40).getTime(), adId: adIds.get("A2")!, variantId: variantIds.get("A2:A")!, d: 1, forceAngry: true });
  }

  // Heat pump CPL interrupt (A4) — the reason it is paused. Numbers come from the generated metrics.
  {
    const t = torontoAt(5, 7, 12);
    const a4 = ["A4:A", "A4:B"].flatMap((k) => variantDaily.get(variantIds.get(k)!) ?? []);
    const sum = (from: number, to: number) => {
      const xs = a4.filter((h) => h.day >= from && h.day <= to);
      return { spend: xs.reduce((s, h) => s + h.spend, 0), leads: xs.reduce((s, h) => s + h.leads, 0) };
    };
    const recent = sum(6, 9);
    const prior = sum(10, 16);
    const fmt = (x: { spend: number; leads: number }) =>
      x.leads ? `$${(x.spend / x.leads).toFixed(2)} CPL (${x.leads} leads)` : `$${x.spend.toFixed(2)} spent, 0 leads`;
    log({ at: t, agent: "analyst", department: "paid_ads", action: "detect_cpl_jump", status: "escalated",
      decision: `Heat Pump Quotes last 4 days: ${fmt(recent)} vs prior 7 days: ${fmt(prior)}. Recommend HOLD, not spend.`,
      entityType: "ad", entityId: adIds.get("A4"), cost: 0.004, latency: 1800 });
    log({ at: at(t.getTime() + MIN), agent: "growth-director", department: "orchestration", action: "interrupt", status: "interrupt",
      decision: "CPL jump on Heat Pump Quotes — paused this ad's thread only and notified owner with recommendation: pause & rewrite.",
      entityType: "ad", entityId: adIds.get("A4"), details: { trigger: "cpl_jump", recent, prior } });
    const apId = randomUUID();
    rows.approvals.push({
      id: apId, kind: "budget_reallocation", ad_id: adIds.get("A4"), ad_variant_id: null,
      title: "Pause Heat Pump Quotes (CPL jump)", summary: `Last 4 days: ${fmt(recent)} vs prior 7: ${fmt(prior)}. Pause both variants; $12/day returns to pool.`,
      payload: JSON.stringify({ action: "pause", ad: "A4", budget_delta_cad: -12 }), original_payload: null,
      requested_by_agent: "analyst", status: "approved", edited: false, edited_by: null, edited_at: null,
      decided_by: OWNER, decided_at: at(t.getTime() + 25 * MIN), decision_note: "Agreed — pause and rethink the offer.",
      expires_at: at(t.getTime() + DAY), spend_delta_cad: -12, idempotency_key: `approval:pause:${adIds.get("A4")}`,
      created_at: at(t.getTime() + MIN), updated_at: at(t.getTime() + 25 * MIN),
    });
    log({ at: at(t.getTime() + 25 * MIN), agent: "owner", department: "paid_ads", action: "approve",
      decision: "Approved pause of Heat Pump Quotes", entityType: "approval", entityId: apId, approvalId: apId });
  }

  // Budget-limit interrupt: a requested budget increase that would breach the weekly cap is blocked in code.
  {
    const t = torontoAt(8, 14, 5);
    log({ at: t, agent: "system", department: "paid_ads", action: "spend_cap_check", status: "blocked",
      decision: "Blocked: +$10/day on 24/7 Emergency Plumbing would project this week to $512 > $500 weekly cap",
      entityType: "ad", entityId: adIds.get("A2"), details: { projected_week_cad: 512, weekly_cap_cad: 500 } });
    log({ at: at(t.getTime() + 30_000), agent: "growth-director", department: "orchestration", action: "interrupt", status: "interrupt",
      decision: "Budget limit reached — paid-ads budget changes paused until Monday's reset; owner notified. Live ads keep running at current budgets.",
      entityType: "ad", entityId: adIds.get("A2"), details: { trigger: "budget_limit_reached" } });
  }

  // Live classification on each variant = its latest cycle verdict.
  for (const v of rows.ad_variants) {
    const latest = latestVerdict.get(v.id as string);
    if (latest) {
      v.classification = latest.classification;
      v.score_breakdown = JSON.stringify(latest);
    }
  }

  buildPendingQueue(adIds, variantIds);

  // -------------------------------------------------------------------------
  // nested builders (closures over the helpers above)
  // -------------------------------------------------------------------------

  function signalFor(source: string, t: number, payload: Row, triage: { intent: string; confidence: number; route: string; urgency?: string }) {
    const id = randomUUID();
    const ext = `mock_evt_${id.slice(0, 8)}`;
    const processed = at(t + int(400, 1500));
    rows.signals.push({
      id, source, external_id: ext, received_at: at(t), payload: JSON.stringify(payload),
      classification: JSON.stringify({ signal_id: id, intent: triage.intent, confidence: triage.confidence, language: "en",
        urgency: triage.urgency ?? "normal", route_to: triage.route }),
      intent: triage.intent, confidence: triage.confidence, route_to: triage.route, processed_at: processed,
      idempotency_key: `evt:${ext}`, created_at: at(t), updated_at: processed,
    });
    log({ at: processed, agent: "triage", department: "lead_capture", action: "classify_signal",
      decision: `${triage.intent} (${triage.confidence.toFixed(2)}) → ${triage.route}`,
      status: triage.route === "human" ? "escalated" : "ok", entityType: "signal", entityId: id,
      cost: 0.0004, latency: int(250, 900) });
    return id;
  }

  function commentFor(args: { signalId: string; t: number; adId: string | null; variantId: string | null; body: string;
    intent: string; sentiment: string; status: string; platform: string; kind?: string; reply?: { text: string; by: string; at: number } }) {
    const id = randomUUID();
    const name = `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase().replace(/[^a-z]/g, "")}${int(1, 99)}`;
    rows.comments.push({
      id, signal_id: args.signalId, ad_id: args.adId, ad_variant_id: args.variantId, platform: args.platform,
      kind: args.kind ?? "comment", author_handle: name, body: args.body, intent: args.intent, sentiment: args.sentiment,
      status: args.status, reply_text: args.reply?.text ?? null, replied_by: args.reply?.by ?? null,
      replied_at: args.reply ? at(args.reply.at) : null, idempotency_key: args.reply ? `reply:${id}` : null,
      created_at: at(args.t), updated_at: at(args.reply?.at ?? args.t),
    });
    return id;
  }

  function createLead(args: { t: number; adKey: string | null; adId: string | null; variantId: string | null; service: Service; isToday: boolean }) {
    const viaComment = args.adId ? chance(0.6) : chance(0.5);
    const platform = pick(["instagram", "facebook", "facebook"]);
    const body = pick(BUYING[args.service]);
    let commentId: string | null = null;
    let signalId: string;
    const tSignal = args.t;
    if (viaComment) {
      const isDm = !args.adId;
      signalId = signalFor(`${platform}_${isDm ? "dm" : "comment"}`, tSignal, { text: body, platform }, {
        intent: "buying_intent", confidence: round2(between(0.82, 0.97)), route: "lead-qualifier", urgency: args.service === "emergency_plumbing" ? "high" : "normal" });
      const replyAt = tSignal + int(5, 40) * 1000;
      commentId = commentFor({ signalId, t: tSignal, adId: args.adId, variantId: args.variantId, body, intent: "buying_intent",
        sentiment: "neutral", status: "replied", platform, kind: isDm ? "dm" : "comment",
        reply: { text: CAPTURE_TEMPLATE, by: "lead-qualifier", at: replyAt } });
      log({ at: at(replyAt), agent: "lead-qualifier", department: "lead_capture", action: "send_capture_link",
        decision: "Replied with approved capture-link template (simulated)", entityType: "comment", entityId: commentId,
        cost: 0, latency: int(300, 1200), key: `log:reply:${commentId}` });
    } else {
      signalId = signalFor("lead_form", tSignal, { form: "quote_request", service: args.service }, {
        intent: "buying_intent", confidence: round2(between(0.9, 0.99)), route: "lead-qualifier" });
    }

    const leadAt = viaComment ? tSignal + int(2, 25) * MIN : tSignal + int(5, 30) * 1000;
    if (leadAt > NOW - 2 * MIN) return; // submission hasn't happened yet
    const first = pick(FIRST);
    const last = pick(LAST);
    const consent = chance(0.9);
    const [lo, hi] = JOB_VALUE[args.service];
    const estimate = round2(between(lo, hi));
    const leadId = randomUUID();
    const city = pick(CITIES);
    rows.leads.push({
      id: leadId, signal_id: signalId, comment_id: commentId, ad_id: args.adId, ad_variant_id: args.variantId, customer_id: null,
      name: `${first} ${last}`, phone: `(905) 555-01${String(int(0, 99)).padStart(2, "0")}`,
      email: `${first.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "")}.${last.toLowerCase().replace(/[^a-z]/g, "")}@example.com`,
      city, service_requested: args.service, estimated_value_cad: estimate,
      consent_given: consent, consent_at: consent ? at(leadAt) : null, consent_text: consent ? CONSENT_TEXT : null,
      consent_source: consent ? "capture_form_checkbox" : null, status: "new",
      idempotency_key: `lead.created:${signalId}`, created_at: at(leadAt), updated_at: at(leadAt),
    });
    const lead = rows.leads[rows.leads.length - 1];
    log({ at: at(leadAt), agent: "lead-qualifier", department: "lead_capture", action: "create_lead",
      decision: `Lead created: ${SERVICE_LABEL[args.service]}, ${city}${consent ? ", consent stored" : ", NO consent — no callback"}`,
      entityType: "lead", entityId: leadId, key: `log:lead:${leadId}` });

    if (!consent) {
      log({ at: at(leadAt + 1000), agent: "voice-dispatcher", department: "sales_response", action: "skip_call", status: "blocked",
        decision: "CASL: no stored consent — callback refused; routed to owner for manual follow-up", entityType: "lead", entityId: leadId });
      return;
    }

    const bigDeal = estimate >= BIG_DEAL_CAD;
    const speed = chance(0.88) ? int(14, 58) : int(61, 240);
    const callStart = leadAt + speed * 1000;
    if (callStart > NOW - MIN) return;
    lead.status = "contacted";

    if (bigDeal) {
      log({ at: at(leadAt + 2000), agent: "growth-director", department: "sales_response", action: "interrupt", status: "interrupt",
        decision: `Big deal detected: ${SERVICE_LABEL[args.service]} est. $${Math.round(estimate).toLocaleString("en-CA")} — routed to ${SALES_LEAD} and owner alongside the agent call`,
        entityType: "lead", entityId: leadId, details: { trigger: "big_deal", estimate } });
    }

    let outcome: string;
    const r = rand();
    if (bigDeal) outcome = "big_deal_handoff";
    else if (r < 0.48) outcome = "booked";
    else if (r < 0.66) outcome = "follow_up";
    else if (r < 0.8) outcome = "no_answer";
    else if (r < 0.85) outcome = "voicemail";
    else if (r < 0.9) outcome = "asked_for_human";
    else outcome = "not_interested";
    // Demo coverage: make sure the "caller asks for a person" interrupt shows up in the last week.
    if (!interruptAskedHuman && outcome === "follow_up" && callStart > NOW - 7 * DAY) outcome = "asked_for_human";

    const makeCall = (attempt: number, start: number, oc: string) => {
      const callId = randomUUID();
      const answered = ["no_answer", "voicemail", "failed"].includes(oc) ? null : start + int(4, 15) * 1000;
      const duration = answered ? int(70, 320) : oc === "voicemail" ? int(25, 40) : 0;
      const summaries: Record<string, string> = {
        booked: `Caller wants ${SERVICE_LABEL[args.service].toLowerCase()}. Confirmed address in ${city}. Booked a visit.`,
        follow_up: "Interested but needs to check with partner. Agreed to a follow-up call tomorrow.",
        no_answer: "No answer.",
        voicemail: "Left voicemail with callback number and reference.",
        asked_for_human: "Caller asked to speak with a person. Handed off to sales team.",
        not_interested: "Was price-shopping; not booking right now. Thanked them.",
        big_deal_handoff: `High-value ${SERVICE_LABEL[args.service].toLowerCase()} enquiry. Gathered home details; warm handoff to ${SALES_LEAD}.`,
      };
      rows.calls.push({
        id: callId, lead_id: leadId, direction: "outbound", attempt, started_at: at(start), answered_at: answered ? at(answered) : null,
        ended_at: at(start + (duration + 10) * 1000), duration_s: duration, outcome: oc, transcript_summary: summaries[oc],
        est_cost_cad: round2((duration / 60) * 0.15), is_simulated: true,
        idempotency_key: `call:${leadId}:attempt:${attempt}`, created_at: at(start), updated_at: at(start + (duration + 10) * 1000),
      });
      log({ at: at(start), agent: "voice-dispatcher", department: "sales_response", action: "place_call",
        decision: `Attempt ${attempt}: ${oc.replaceAll("_", " ")} — ${Math.round((start - leadAt) / 1000)}s after lead (simulated)`,
        status: oc === "asked_for_human" || oc === "big_deal_handoff" ? "escalated" : "ok",
        entityType: "call", entityId: callId, cost: round2((duration / 60) * 0.15), latency: int(800, 2000),
        key: `log:call:${leadId}:${attempt}` });
      return callId;
    };

    let callId = makeCall(1, callStart, outcome);
    if (outcome === "no_answer") {
      const retry = callStart + int(10, 30) * MIN;
      if (retry < NOW - MIN) {
        outcome = chance(0.45) ? "booked" : chance(0.5) ? "voicemail" : "no_answer";
        callId = makeCall(2, retry, outcome);
        if (outcome === "no_answer") {
          log({ at: at(retry + MIN), agent: "voice-dispatcher", department: "sales_response", action: "escalate", status: "escalated",
            decision: "Two failed attempts — routed to owner / sales team", entityType: "lead", entityId: leadId });
        }
      }
    }
    if (outcome === "asked_for_human") {
      lead.status = "handoff";
      if (interruptAskedHuman++ < 4) {
        log({ at: at(callStart + 90_000), agent: "growth-director", department: "sales_response", action: "interrupt", status: "interrupt",
          decision: `Caller asked for a person — paused agent on this lead, notified ${SALES_LEAD}`, entityType: "lead", entityId: leadId,
          details: { trigger: "caller_asks_for_person" } });
      }
    }
    if (outcome === "not_interested") lead.status = "lost";

    const books = outcome === "booked" || (outcome === "big_deal_handoff" && chance(0.7));
    if (!books) {
      if (outcome === "big_deal_handoff") lead.status = "handoff";
      return;
    }

    // Booking → customer → appointment → (maybe) paid.
    const custId = randomUUID();
    rows.customers.push({ id: custId, name: lead.name, phone: lead.phone, email: lead.email, city,
      first_ad_id: args.adId, created_at: at(callStart + 5 * MIN), updated_at: at(callStart + 5 * MIN) });
    lead.customer_id = custId;
    lead.status = "booked";
    const daysOut = int(1, 4);
    const slotDay = Math.ceil((torontoAt(0, 0).getTime() - leadAt) / DAY) - daysOut;
    const scheduled = torontoAt(slotDay, pick([8, 9, 10, 11, 13, 14, 15, 16]), pick([0, 30]));
    const apptId = randomUUID();
    let status = "scheduled";
    let paidAt: Date | null = null;
    let paid: number | null = null;
    const jobValue = round2(between(lo, hi));
    if (scheduled.getTime() + 3 * HOUR < NOW) {
      const r2 = rand();
      status = r2 < 0.8 ? "completed" : r2 < 0.92 ? "no_show" : "cancelled";
      if (status === "completed") {
        // Most pay on the day; some invoices sit open for up to a week.
        const payT = scheduled.getTime() + (chance(0.7) ? int(1, 6) : int(24, 168)) * HOUR;
        if (payT < NOW) {
          paidAt = at(payT);
          paid = jobValue;
        }
      }
    }
    rows.appointments.push({
      id: apptId, lead_id: leadId, call_id: callId, customer_id: custId, service: args.service, scheduled_for: scheduled,
      status, job_value_cad: jobValue, paid_amount_cad: paid, paid_at: paidAt, calendar_event_id: `mock_gcal_${apptId.slice(0, 10)}`,
      idempotency_key: `booking:${leadId}`, created_at: at(callStart + 5 * MIN), updated_at: paidAt ?? at(callStart + 5 * MIN),
    });
    log({ at: at(callStart + 5 * MIN), agent: "voice-dispatcher", department: "sales_response", action: "book_appointment",
      decision: `Booked ${SERVICE_LABEL[args.service]} for ${scheduled.toLocaleString("en-CA", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" })} (simulated calendar)`,
      entityType: "appointment", entityId: apptId, key: `log:booking:${leadId}` });
    if (paidAt) {
      log({ at: paidAt, agent: "system", department: "sales_response", action: "payment_recorded",
        decision: `Paid $${paid!.toFixed(2)} — ${SERVICE_LABEL[args.service]}`, entityType: "appointment", entityId: apptId });
    }
  }

  function createOtherComment(args: { t: number; adId: string; variantId: string; d: number; forceAngry?: boolean }) {
    const r = args.forceAngry ? 0.9 : rand();
    const platform = pick(["instagram", "facebook", "facebook"]);
    let body: string, intent: string, sentiment: string, route: string, conf: number, status: string;
    if (r < 0.32) { body = pick(QUESTIONS); intent = "question"; sentiment = "neutral"; route = "lead-qualifier"; conf = between(0.74, 0.9); status = "replied"; }
    else if (r < 0.6) { body = pick(POSITIVE); intent = "other"; sentiment = "positive"; route = "ignore"; conf = between(0.8, 0.95); status = "ignored"; }
    else if (r < 0.72) { body = pick(COMPLAINTS); intent = "complaint"; sentiment = "negative"; route = "reputation-guard"; conf = between(0.75, 0.92); status = "escalated"; }
    else if (r < 0.86) { body = pick(SPAM); intent = "spam"; sentiment = "neutral"; route = "ignore"; conf = between(0.9, 0.99); status = "ignored"; }
    else if (r < 0.93) { body = pick(ANGRY); intent = "angry"; sentiment = "angry"; route = "human"; conf = between(0.8, 0.96); status = "escalated"; }
    else { body = pick(AMBIGUOUS); intent = "other"; sentiment = "neutral"; route = "human"; conf = between(0.5, 0.68); status = "escalated"; }
    conf = round2(conf);
    const signalId = signalFor(`${platform}_comment`, args.t, { text: body, platform }, { intent, confidence: conf, route,
      urgency: intent === "angry" ? "high" : "normal" });
    const reply = intent === "question"
      ? { text: "Good question — send us a message or pop your number here and we'll call you right back: https://northshore.example/quote", by: "lead-qualifier", at: args.t + int(10, 60) * 1000 }
      : undefined;
    const commentId = commentFor({ signalId, t: args.t, adId: args.adId, variantId: args.variantId, body, intent, sentiment, status, platform, reply });
    if (reply) {
      log({ at: at(reply.at), agent: "lead-qualifier", department: "lead_capture", action: "reply_template",
        decision: "Answered with approved FAQ template (simulated)", entityType: "comment", entityId: commentId, key: `log:reply:${commentId}` });
    }
    if (intent === "angry") {
      log({ at: at(args.t + 1500), agent: "reputation-guard", department: "reputation", action: "escalate_angry", status: "escalated",
        decision: "Angry comment — human only. No auto-reply, no auto-hide. Owner notified.", entityType: "comment", entityId: commentId });
      if (!interruptLoggedAngry && args.d <= 3) {
        interruptLoggedAngry = true;
        log({ at: at(args.t + 40 * MIN), agent: "growth-director", department: "reputation", action: "interrupt", status: "interrupt",
          decision: "Angry comment spreading (4 replies agreeing in 40 min) — paused automation on this thread, owner notified with suggested calm response for them to post personally.",
          entityType: "comment", entityId: commentId, details: { trigger: "angry_comment_spreading", replies: 4 } });
      }
    }
    if (intent === "complaint") {
      log({ at: at(args.t + 3000), agent: "reputation-guard", department: "reputation", action: "flag_complaint", status: "escalated",
        decision: "Routine complaint — flagged for owner review", entityType: "comment", entityId: commentId });
    }
  }

  function createReview(t: number) {
    const stars = pick([5, 5, 5, 4, 4, 3, 2]);
    const text = stars >= 4 ? pick(POSITIVE) : stars === 3 ? "Good work but scheduling took a while." : pick(COMPLAINTS);
    const route = stars >= 4 ? "reputation-guard" : stars === 3 ? "reputation-guard" : "human";
    const signalId = signalFor("review", t, { stars, text, site: "Google (mock)" }, {
      intent: stars >= 3 ? "other" : "complaint", confidence: round2(between(0.8, 0.95)), route });
    log({ at: at(t + 5000), agent: "reputation-guard", department: "reputation", action: stars >= 3 ? "draft_reply" : "escalate_review",
      status: stars >= 3 ? "ok" : "escalated",
      decision: stars >= 3 ? `Drafted thank-you reply to ${stars}★ review (needs approval)` : `${stars}★ review — escalated to owner`,
      entityType: "signal", entityId: signalId, cost: 0.002 });
  }

  function runCycle(d: number) {
    const t = torontoAt(d, 6, 30);
    const proposals: string[] = [];
    let netDelta = 0;
    for (const ad of ADS) {
      for (const v of ad.variants) {
        const vId = variantIds.get(`${ad.key}:${v.label}`)!;
        const hist = (variantDaily.get(vId) ?? []).filter((h) => h.day > d && h.day <= d + 2);
        if (!hist.length || !isLive(v, d + 1)) continue;
        const stats: VariantCycleStats = {
          ad_variant_id: vId,
          spend: round2(hist.reduce((s, h) => s + h.spend, 0)),
          impressions: 0,
          leads: hist.reduce((s, h) => s + h.leads, 0),
        };
        stats.impressions = rows.metrics
          .filter((m) => m.ad_variant_id === vId && hist.some((h) => torontoDateString(torontoAt(h.day, 12).getTime()) === m.metric_date))
          .reduce((s, m) => s + (m.impressions as number), 0);
        // Classify on a rolling 10-day window (last 5 cycles) so low-volume local ads can reach the 5-lead winner bar.
        const window = (variantDaily.get(vId) ?? []).filter((h) => h.day > d && h.day <= d + 10);
        const verdict = classifyVariant(
          { ...stats, spend: round2(window.reduce((s, h) => s + h.spend, 0)), leads: window.reduce((s, h) => s + h.leads, 0) },
          ad.targetCpl,
        );
        latestVerdict.set(vId, verdict);
        log({ at: t, agent: "analyst", department: "paid_ads", action: "classify_variant",
          decision: `${ad.key}-${v.label}: ${verdict.classification} → ${verdict.recommended_action} (CPL ${verdict.cost_per_lead ? "$" + verdict.cost_per_lead.toFixed(2) : "n/a"}, ${verdict.leads} leads)`,
          entityType: "ad_variant", entityId: vId, cost: 0.003, latency: int(900, 2500), details: verdict as unknown as Row });
        if (verdict.recommended_action === "scale") proposals.push(`+${verdict.budget_delta_pct}% ${ad.key}-${v.label}`);
        if (verdict.recommended_action === "kill") proposals.push(`kill ${ad.key}-${v.label}`);
        netDelta += verdict.budget_delta_pct;
      }
    }
    if (!proposals.length) return;
    const apId = randomUUID();
    const cycleId = `cycle:${torontoDateString(t.getTime())}`;
    const decidedAt = at(t.getTime() + int(1, 9) * HOUR);
    const r = rand();
    const status = d < 3 ? "pending" : r < 0.75 ? "approved" : r < 0.9 ? "rejected" : "expired";
    if (status === "pending") return; // the live one is built in buildPendingQueue
    rows.approvals.push({
      id: apId, kind: "budget_reallocation", ad_id: null, ad_variant_id: null, title: `48h cycle reallocation — ${torontoDateString(t.getTime())}`,
      summary: proposals.join(", "), payload: JSON.stringify({ cycle_id: cycleId, proposals, net_budget_delta_pct: netDelta }),
      original_payload: null, requested_by_agent: "analyst", status, edited: false, edited_by: null, edited_at: null,
      decided_by: status === "expired" ? null : OWNER, decided_at: status === "expired" ? null : decidedAt,
      decision_note: status === "rejected" ? "Hold for one more cycle." : status === "expired" ? "No response within 24h — budget left unchanged." : null,
      expires_at: at(t.getTime() + DAY), spend_delta_cad: 0, idempotency_key: `approval:${cycleId}`, created_at: t,
      updated_at: status === "expired" ? at(t.getTime() + DAY) : decidedAt,
    });
    log({ at: at(t.getTime() + 2 * MIN), agent: "analyst", department: "paid_ads", action: "propose_reallocation",
      decision: `Proposed: ${proposals.join(", ")} — awaiting owner approval`, entityType: "approval", entityId: apId, approvalId: apId,
      key: `log:${cycleId}` });
    if (status !== "expired") {
      log({ at: decidedAt, agent: "owner", department: "paid_ads", action: status === "approved" ? "approve" : "reject",
        decision: `${status === "approved" ? "Approved" : "Rejected"} cycle reallocation (${proposals.length} change${proposals.length > 1 ? "s" : ""})`,
        entityType: "approval", entityId: apId, approvalId: apId });
    } else {
      log({ at: at(t.getTime() + DAY), agent: "system", department: "paid_ads", action: "approval_expired",
        decision: "Reallocation expired after 24h with no decision — budget unchanged (never auto-approved)",
        entityType: "approval", entityId: apId, approvalId: apId });
    }
  }
}

const latestVerdict = new Map<string, ReturnType<typeof classifyVariant>>();

/** The owner's queue this morning: drafts and proposals waiting on a human decision. */
function buildPendingQueue(adIds: Map<string, string>, variantIds: Map<string, string>) {
  const mins = (m: number) => at(NOW - m * MIN);
  const last7 = new Set(Array.from({ length: 7 }, (_, i) => torontoDateString(torontoAt(i + 1, 12).getTime())));
  const projectedWeek = rows.metrics.filter((m) => last7.has(m.metric_date as string)).reduce((s, m) => s + (m.spend_cad as number), 0) + 4 * 7;
  const pending: Array<{
    kind: string; ad?: string; title: string; summary: string; payload: Row; agent: string; minutesAgo: number;
    expiresH: number; variant?: { label: string; headline: string; primaryText: string; cta: string; voiceover: string; factCheck?: boolean };
    spendDelta?: number;
  }> = [
    { kind: "ad_variant", ad: "A1", agent: "ad-writer", minutesAgo: 95, expiresH: 48,
      title: "Furnace Tune-Up — Fall 2026 — variant E",
      summary: "Learns from winner A (cold-night hook). Tests a weekend-availability angle.",
      variant: { label: "E", headline: "Weekend furnace tune-ups now booking",
        primaryText: "Can't take a weekday off? Licensed Northshore techs now book Saturdays. We call you back within a minute.",
        cta: "Get a call back", voiceover: "Can't take a weekday off? Northshore now books Saturday furnace tune-ups." },
      payload: { rubric_source: "A1-A winner (score 8)", batch: "2 of 20 shortlisted by analyst" } },
    { kind: "ad_variant", ad: "A1", agent: "ad-writer", minutesAgo: 94, expiresH: 48,
      title: "Furnace Tune-Up — Fall 2026 — variant F",
      summary: "Competitor-inspired: a long-running 'first cold night' furnace concept from the Ad Library learn-from tier.",
      variant: { label: "F", headline: "Hear that clicking? Your furnace is asking for a tune-up",
        primaryText: "Strange noises usually mean something's worn. A licensed tech will check it before it quits. Burlington, Oakville, Milton, Hamilton Mountain.",
        cta: "Get a call back", voiceover: "Hear that clicking? Your furnace is asking for a tune-up. Call Northshore." },
      payload: { rubric_source: "Competitor concept: long-running 'first cold night' furnace video (learn-from tier)" } },
    { kind: "ad_variant", ad: "A3", agent: "ad-writer", minutesAgo: 88, expiresH: 48,
      title: "Water Heater Replacement — variant C (⚠ fact check)",
      summary: "Mentions a government rebate — NOT in MUSE.md verified facts. Flagged by ad-writer.",
      variant: { label: "C", headline: "New water heater + rebate help",
        primaryText: "Ask about energy rebates when you book your free in-home quote.",
        cta: "Get a free quote", voiceover: "Ask about energy rebates on your new water heater.", factCheck: true },
      payload: { flag: "Unverified claim: rebate eligibility. Owner must confirm before this can publish." } },
    { kind: "organic_post", agent: "ad-writer", minutesAgo: 80, expiresH: 48,
      title: "Instagram carousel: 5-point fall furnace checklist",
      summary: "Organic post for Saturday 10:00. No spend.",
      payload: { channel: "instagram", scheduled_for: "Saturday 10:00", caption: "Five things to check before the first cold night 🍂 1) Change the filter 2) Clear the vents 3) Test the thermostat 4) Check the CO detector 5) Book a licensed tune-up. Questions? Drop them below 👇", slides: 6 } },
    { kind: "organic_post", agent: "ad-writer", minutesAgo: 62, expiresH: 48,
      title: "Reel script: 3 signs your water heater is failing",
      summary: "30-second reel, voiceover by ElevenLabs (simulated). No spend.",
      payload: { channel: "instagram_reels", script: "Rusty water. Rumbling tank. Puddles at the base. Any of these? Book a free in-home quote with Northshore." } },
    { kind: "budget_reallocation", agent: "analyst", minutesAgo: 45, expiresH: 24, spendDelta: 4,
      title: `48h cycle reallocation — ${torontoDateString(NOW)}`,
      summary: `Scale A1-A +20% ($4/day) from the paused Heat Pump pool. Projected 7-day spend $${projectedWeek.toFixed(0)} < $500 cap.`,
      payload: { proposals: ["+20% A1-A", "hold A1-B", "retest A3-B"], weekly_projection_cad: round2(projectedWeek), weekly_cap_cad: 500 } },
    { kind: "reputation_reply", agent: "reputation-guard", minutesAgo: 30, expiresH: 12,
      title: "Reply to 3★ Google review (mock)",
      summary: "\"Good work but scheduling took a while.\" Calm, no excuses, invites a direct call.",
      payload: { review: "Good work but scheduling took a while.", draft_reply: "Thanks for the honest feedback — glad the work was right, and sorry the scheduling dragged. We've added Saturday slots this fall. If you'd like to talk it through, call Dana directly at the shop." } },
  ];

  for (const p of pending) {
    const created = mins(p.minutesAgo);
    let variantId: string | null = null;
    if (p.variant && p.ad) {
      variantId = randomUUID();
      variantIds.set(`${p.ad}:${p.variant.label}`, variantId);
      rows.ad_variants.push({
        id: variantId, ad_id: adIds.get(p.ad), label: p.variant.label, headline: p.variant.headline, primary_text: p.variant.primaryText,
        cta: p.variant.cta, voiceover_script: p.variant.voiceover, video_url: null, voiceover_url: null, status: "draft",
        classification: null, score_breakdown: null, needs_fact_check: !!p.variant.factCheck, created_by_agent: "ad-writer",
        published_at: null, idempotency_key: null, created_at: created, updated_at: created,
      });
      log({ at: created, agent: "ad-writer", department: "content_studio", action: "draft_variant",
        decision: `Drafted ${p.ad}-${p.variant.label}: "${p.variant.headline}"${p.variant.factCheck ? " — flagged unverified claim" : ""}`,
        status: p.variant.factCheck ? "escalated" : "ok", entityType: "ad_variant", entityId: variantId, cost: 0.018, latency: int(4000, 9000) });
    }
    const apId = randomUUID();
    const payload = p.variant ? { headline: p.variant.headline, primary_text: p.variant.primaryText, cta: p.variant.cta, voiceover_script: p.variant.voiceover, ...p.payload } : p.payload;
    rows.approvals.push({
      id: apId, kind: p.kind, ad_id: p.ad ? adIds.get(p.ad) : null, ad_variant_id: variantId, title: p.title, summary: p.summary,
      payload: JSON.stringify(payload), original_payload: null, requested_by_agent: p.agent, status: "pending", edited: false,
      edited_by: null, edited_at: null, decided_by: null, decided_at: null, decision_note: null,
      expires_at: at(created.getTime() + p.expiresH * HOUR), spend_delta_cad: p.spendDelta ?? null,
      idempotency_key: `approval:${p.kind}:${variantId ?? apId}`, created_at: created, updated_at: created,
    });
    log({ at: at(created.getTime() + 30_000), agent: "growth-director", department: "orchestration", action: "queue_for_approval",
      decision: `Sent to owner: ${p.title}`, entityType: "approval", entityId: apId, approvalId: apId });
  }
}

// ---------------------------------------------------------------------------

export async function seed(url = databaseUrl()): Promise<Record<string, number>> {
  build();
  const client = newClient(url);
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`TRUNCATE ${[...INSERT_ORDER].reverse().join(", ")} RESTART IDENTITY CASCADE`);
    await insertAll(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
  return Object.fromEntries(INSERT_ORDER.map((t) => [t, rows[t].length]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then((counts) => {
      console.log("Seeded Northshore Plumbing & Heating (fictional, mock data):");
      for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(20)} ${n}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
