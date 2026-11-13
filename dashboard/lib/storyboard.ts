/**
 * Storyboard: the exact words and numbers of one credit union's story video, built ONLY from statements
 * the owner has approved. Pure and deterministic. The render worker draws exactly this, nothing else.
 *
 *   intro → the years (approved chapters, with the assets chart) → whole-period trends
 *         → each approved pain point, followed by how Trisanga can help → close
 */
import type { Claim, PainPoint, Story } from "./story";

export type Format = "vertical" | "wide";
export interface Figure { label: string; value: string; year: number }
export type Scene =
  | { kind: "intro"; seconds: number; name: string; short: string; place: string | null; years: string }
  | { kind: "years"; seconds: number; items: { year: number; text: string; assets: number | null; assetsText: string | null }[] }
  | { kind: "trend"; seconds: number; title: string; text: string; from: Figure; to: Figure }
  | { kind: "pain"; seconds: number; title: string; text: string; figures: Figure[] }
  | { kind: "help"; seconds: number; offering: string; promise: string; how: string; learn: string }
  | { kind: "close"; seconds: number; short: string; sources: string };
export interface Storyboard { version: 1; cuId: string; cuName: string; scenes: Scene[]; seconds: number }
export interface ClaimRef { key: string; hash: string }
export interface Readiness { ready: boolean; missing: string[]; approvedChapters: number; approvedPains: number; claims: ClaimRef[] }

export interface StoryboardInput {
  cu: { id: string; name: string; short_name: string; city: string | null; head_office: string | null };
  story: Story;
  approved: (c: Claim) => boolean;
  offerings: { key: string; title: string; promise: string; how_we_help: string; learn: string; active: boolean }[];
}

export const MIN_CHAPTERS = 2;
export const MAX_PAINS = 3;

export function readiness({ story, approved }: Pick<StoryboardInput, "story" | "approved">): Readiness {
  const chapters = story.chapters.filter(approved), pains = story.pains.filter(approved).slice(0, MAX_PAINS);
  const missing: string[] = [];
  if (!story.enough) missing.push("ONCU needs at least three years of audited numbers for this credit union");
  if (chapters.length < MIN_CHAPTERS) missing.push(`approve at least ${MIN_CHAPTERS} years of the story (${chapters.length} approved)`);
  if (!pains.length) missing.push("approve at least one pain point");
  const claims = [...chapters, ...story.trends.filter(approved), ...pains].map((c) => ({ key: c.key, hash: c.hash }));
  return { ready: !missing.length, missing, approvedChapters: chapters.length, approvedPains: pains.length, claims };
}

const fig = (c: Claim, i: number): Figure => ({ label: c.evidence[i].label, value: c.evidence[i].display, year: c.evidence[i].year });

export function buildStoryboard(input: StoryboardInput): { storyboard: Storyboard; claims: ClaimRef[] } | { missing: string[] } {
  const { cu, story, approved, offerings } = input;
  const r = readiness(input);
  if (!r.ready) return { missing: r.missing };
  const chapters = story.chapters.filter(approved);
  const trends = story.trends.filter(approved);
  const pains = story.pains.filter(approved).slice(0, MAX_PAINS) as PainPoint[];
  const offer = new Map(offerings.filter((o) => o.active).map((o) => [o.key, o]));
  const years = chapters.map((c) => Number(c.key.split(":")[1]));

  const scenes: Scene[] = [
    { kind: "intro", seconds: 5, name: cu.name, short: cu.short_name, place: cu.city ?? cu.head_office,
      years: years.length > 1 ? `FY${years[0]}–FY${years.at(-1)}` : `FY${years[0]}` },
    { kind: "years", seconds: 2 + chapters.length * 3.2,
      items: chapters.map((c) => {
        const a = c.evidence.find((e) => e.metric === "assets");
        return { year: Number(c.key.split(":")[1]), text: c.text, assets: a?.value ?? null, assetsText: a?.display ?? null };
      }) },
    ...trends.map((t): Scene => ({ kind: "trend", seconds: 5, title: t.title, text: t.text, from: fig(t, 0), to: fig(t, t.evidence.length - 1) })),
  ];
  for (const p of pains) {
    scenes.push({ kind: "pain", seconds: 6, title: p.title, text: p.text, figures: p.evidence.map((_, i) => fig(p, i)) });
    const o = offer.get(p.offering_key);
    if (o) scenes.push({ kind: "help", seconds: 6, offering: o.title, promise: o.promise, how: o.how_we_help, learn: o.learn });
  }
  scenes.push({ kind: "close", seconds: 6, short: cu.short_name,
    sources: `Figures: ${cu.short_name}'s audited financial statements, via ONCU Insights. An educational summary from public information, not an audit.` });
  const storyboard: Storyboard = { version: 1, cuId: cu.id, cuName: cu.name, scenes, seconds: scenes.reduce((s, x) => s + x.seconds, 0) };
  return { storyboard, claims: r.claims };
}
