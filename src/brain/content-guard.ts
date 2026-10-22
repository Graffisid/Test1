/**
 * Guardrails for social content, in code, run on every draft before the owner ever sees it. A draft must pass
 * ALL of them; one failure and it is dropped (and logged with the reason). Uncertainty means drop, not post.
 *
 *   claims        only MUSE.md verified facts and prices; no banned claims, ratings, testimonials, guarantees
 *   no copying    not a near-copy of any competitor ad; no competitor named
 *   safe text     no links, emails, @mentions, markup, hidden/control characters or prompt-injection residue
 *   brand voice   no ALL CAPS, no "!!", no fear-mongering
 *   format        platform limits (caption, hashtags), reel length and pacing, slide counts
 *
 * The analyst then scores what passed (the writer never scores its own work).
 */
import { auditDraft } from "./auditor.ts";
import { similarity } from "./draft-score.ts";
import type { BrandRules } from "./muse.ts";
import type { ContentDraft } from "./schemas.ts";

export interface Check { name: string; ok: boolean; detail: string }
export interface GuardContext { rules: BrandRules; competitorNames: string[]; competitorTexts: string[] }

const BUSINESS_PHONE = /\(905\) 555-0100/g;
const FEAR = /\b(deadly|death|die|kill(s|ing)?|explod\w*|catastroph\w*|disaster|nightmare|ruin(ed)?|panic|terrif\w*)\b/i;
const INJECTION = /\b(ignore (all |the )?(previous|prior|above)|system prompt|you are (now )?an? (ai|assistant|model)|as an ai)\b/i;

/** Every human-readable string in a draft, for checks that look at all of it. */
export function draftText(d: ContentDraft): string {
  return [d.title, d.hook, d.caption, d.visual_brief, ...d.hashtags, ...d.scenes.flatMap((s) => [s.shot, s.on_screen_text, s.voiceover]),
    ...d.slides.flatMap((s) => [s.headline, s.body])].join("\n");
}

function sixGrams(s: string): Set<string> {
  const w = s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 6 <= w.length; i++) out.add(w.slice(i, i + 6).join(" "));
  return out;
}

export function checkContent(d: ContentDraft, ctx: GuardContext): Check[] {
  const text = draftText(d);
  const spoken = [d.hook, d.caption, ...d.scenes.map((s) => `${s.on_screen_text} ${s.voiceover}`), ...d.slides.map((s) => `${s.headline} ${s.body}`)].join("\n");
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, fail: string, pass: string) => checks.push({ name, ok, detail: ok ? pass : fail });

  // Claims, via the same auditor the ads go through. For posts, a flag is a fail: there's no fact-check step on a phone.
  const audit = auditDraft({ headline: d.hook, primary_text: `${d.caption}\n${spoken}`, voiceover_script: d.scenes.map((s) => s.voiceover).join(" "), cta: d.cta }, ctx.rules);
  add("Only verified claims", audit.verdict === "pass", audit.issues.join("; "), "Every claim is in your verified facts");

  // Copying and competitors.
  const named = ctx.competitorNames.filter((n) => n.length > 3 && text.toLowerCase().includes(n.toLowerCase()));
  add("No competitor named", named.length === 0, `mentions ${named.join(", ")}`, "No competitor is named or criticised");
  const mine = sixGrams(spoken);
  let worst = 0, shared = 0;
  for (const c of ctx.competitorTexts) {
    worst = Math.max(worst, similarity(c, d.hook), similarity(c, d.caption));
    for (const g of sixGrams(c)) if (mine.has(g)) shared++;
  }
  add("Original, not copied", worst < 0.5 && shared === 0,
    shared ? `shares ${shared} six-word phrase(s) with a competitor ad` : `too close to a competitor ad (${Math.round(worst * 100)}% similar)`,
    `Original wording (closest competitor ad ${Math.round(worst * 100)}% similar)`);

  // Safe text: nothing that links out, tags people, hides content, or carries markup.
  const noPhone = text.replace(BUSINESS_PHONE, "");
  add("No links or contact details", !/(https?:\/\/|www\.|\b[\w-]+\.(com|ca|net|org|io|ly|co)\b|@\w|\b[\w.+-]+@[\w-]+\.\w+|\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/i.test(noPhone),
    "contains a link, email, @mention or phone number other than yours", "No links, emails, @mentions or outside phone numbers");
  add("No hidden or unsafe characters", !/[<>{}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/.test(text),
    "contains markup or hidden/control characters", "Plain text only");
  add("No instruction residue", !INJECTION.test(text), "reads like leaked instructions", "No leaked instructions");

  // Brand voice.
  const shouting = /\b[A-Z]{4,}\b/.test(text.replace(/\b(HVAC|HST|DIY)\b/g, ""));
  add("Brand voice", !shouting && !/!!/.test(text) && !FEAR.test(text),
    shouting ? "ALL-CAPS shouting" : /!!/.test(text) ? "multiple exclamation marks" : "fear-mongering words", "Calm, plain, local");

  // Format rules per kind and platform.
  const tagsOk = d.hashtags.length <= 8 && d.hashtags.every((h) => /^#[A-Za-z][A-Za-z0-9_]{1,29}$/.test(h));
  const len = d.scenes.reduce((s, x) => s + x.seconds, 0);
  const formatProblem =
    d.kind === "reel" && (d.scenes.length < 3 || len < 7 || len > 60) ? `reel must be 3+ scenes and 7–60 s (is ${d.scenes.length} scenes, ${len} s)`
    : d.kind === "reel" && (d.scenes[0].seconds > 3 || !d.scenes[0].on_screen_text.trim()) ? "a reel needs an on-screen hook in its first 3 seconds"
    : d.kind === "carousel" && (d.slides.length < 3 || d.slides.length > 8) ? "a carousel needs 3–8 slides"
    : d.kind === "image_post" && d.visual_brief.trim().length < 20 ? "an image post needs a visual brief"
    : !tagsOk ? "hashtags must be at most 8, letters/numbers/underscores only"
    : d.caption.length > (d.platform === "instagram" ? 2200 : 2000) ? "caption too long for the platform" : null;
  add("Fits the format", !formatProblem, formatProblem ?? "", `${d.kind === "reel" ? `${len} s reel, ${d.scenes.length} scenes` : d.kind === "carousel" ? `${d.slides.length} slides` : "single image"}, ${d.hashtags.length} hashtags`);

  return checks;
}

export interface ContentScore { hook: number; local: number; proof: number; cta: number; pacing: number; total: number }

const LOCAL = /\b(burlington|oakville|milton|hamilton|halton)\b/i;
const PROOF = /\b(licensed|insured|24\/7|free in-home quote|\$129)\b/i;

/** analyst's score for drafts that passed: a transparent rubric, stored with the item. */
export function scoreContent(d: ContentDraft): ContentScore {
  const hook = (/\?$/.test(d.hook.trim()) || /\b(you|your)\b/i.test(d.hook) ? 2 : 0) + (d.hook.length <= 70 ? 1 : 0);
  const local = LOCAL.test(`${d.hook} ${d.caption}`) ? 2 : 0;
  const proof = PROOF.test(draftText(d)) ? 2 : 0;
  const cta = d.caption.toLowerCase().includes(d.cta.toLowerCase().split(" ").slice(-2).join(" ")) ? 1 : 0;
  const len = d.scenes.reduce((s, x) => s + x.seconds, 0);
  const pacing = d.kind === "reel" ? (len >= 15 && len <= 35 && d.scenes.every((s) => s.seconds <= 6) ? 2 : 0)
    : d.kind === "carousel" ? (d.slides.length >= 4 && d.slides.length <= 7 ? 2 : 1) : 1;
  return { hook, local, proof, cta, pacing, total: hook + local + proof + cta + pacing };
}
