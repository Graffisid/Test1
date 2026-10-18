import Link from "next/link";
import { Icon } from "@/components/Icon";
import { ReviewCard, type ReviewView } from "@/components/review/ReviewCard";
import type { PosterFormat } from "@/components/review/Poster";
import type { Platform } from "@/components/review/SocialPreview";
import { requireOwnerPage } from "@/lib/session";
import { AGENT_LABEL, KIND_COPY, TZ, relative } from "@/lib/format";
import { expireStaleApprovals, getRecentDecisions, getReviewItems, type ReviewRow } from "@/lib/queries";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "all", label: "Everything", kinds: null },
  { key: "posts", label: "Posts & ads", kinds: ["organic_post", "ad_variant"] },
  { key: "bookings", label: "Bookings", kinds: ["booking"] },
  { key: "replies", label: "Review replies", kinds: ["reputation_reply"] },
  { key: "money", label: "Money", kinds: ["budget_reallocation", "ad_launch"] },
] as const;
const PHONE_KINDS = new Set(["organic_post", "ad_variant", "reputation_reply", "booking"]);
const s = (v: unknown) => (typeof v === "string" ? v : null);

/** Toronto wall-clock "YYYY-MM-DDTHH:MM" for a datetime-local input. */
function torontoLocal(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString("en-CA", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;

function toView(a: ReviewRow, now: number, wa: { on: boolean; number: string | null }): ReviewView {
  const copy = KIND_COPY[a.kind] ?? { label: a.kind, ifApproved: "It goes ahead." };
  const p = a.payload ?? {};
  let post: ReviewView["post"] = null;
  if (a.kind === "organic_post" || a.kind === "ad_variant") {
    const format = a.kind === "ad_variant" ? "ad" : (s(p.format) ?? (s(p.channel)?.includes("reel") ? "reel" : Number(p.slides) > 1 ? "carousel" : "image_post"));
    const channel = s(p.platform) ?? s(p.channel) ?? "instagram";
    const platform: Platform = channel.startsWith("facebook") ? "facebook" : channel.startsWith("tiktok") ? "tiktok" : channel.startsWith("linkedin") ? "linkedin" : "instagram";
    const slides = Array.isArray(p.slides) ? p.slides.length : Number(p.slides) || 0;
    const headline = s(p.hook) ?? s(p.headline) ?? a.title.replace(/^[^:]+:\s*/, "");
    post = {
      uid: a.id.slice(0, 8), format: format as PosterFormat,
      headline, sub: a.kind === "ad_variant" ? null : (Array.isArray(p.slides) ? s((p.slides[0] as { headline?: string })?.headline) : null),
      caption: s(p.caption) ?? s(p.primary_text) ?? s(p.script) ?? "",
      hashtags: Array.isArray(p.hashtags) ? (p.hashtags as string[]) : [], cta: s(p.cta), slides,
      sponsored: a.kind === "ad_variant", platform, scheduledLabel: when(a.scheduled_for ?? s(p.scheduled_for)),
    };
  }
  const review = a.kind === "reputation_reply" && s(p.review) && s(p.draft_reply)
    ? { review: s(p.review)!, reply: s(p.draft_reply)!, stars: Number(p.stars) || Number(/(\d)★/.exec(a.title)?.[1]) || 3 } : null;
  const editable = a.kind === "ad_variant" ? [
      { key: "headline", label: "Headline", value: s(p.headline) ?? "", long: false },
      { key: "primary_text", label: "Main text", value: s(p.primary_text) ?? "", long: true },
      { key: "cta", label: "Button", value: s(p.cta) ?? "", long: false }]
    : a.kind === "reputation_reply" ? [{ key: "draft_reply", label: "Your reply", value: s(p.draft_reply) ?? "", long: true }]
    : a.kind === "organic_post" && !p.format ? (["caption", "script"] as const).filter((k) => s(p[k])).map((k) => ({ key: k, label: k === "caption" ? "Caption" : "Video script", value: s(p[k])!, long: true }))
    : [];
  const canSchedule = !!a.content_item_id;
  const sched = a.scheduled_for ? new Date(a.scheduled_for) : new Date(now + 24 * 3600_000);
  return {
    id: a.id, kind: a.kind, kindLabel: copy.label, ifApproved: canSchedule ? "It posts at the time you pick above, once its pictures are made. No spend." : copy.ifApproved,
    title: a.title, summary: a.summary, requestedBy: AGENT_LABEL[a.requested_by_agent] ?? a.requested_by_agent,
    createdLabel: relative(a.created_at, now), expiresLabel: relative(a.expires_at, now), leadId: a.lead_id,
    needsFactCheck: !!a.needs_fact_check, flag: s(p.flag), post, review, payload: p,
    checks: a.checks, score: a.score?.total ?? null,
    scheduleLocal: canSchedule ? torontoLocal(sched.getTime() < now + 20 * 60_000 ? new Date(now + 24 * 3600_000) : sched) : null,
    scheduleMin: torontoLocal(new Date(now + 20 * 60_000)), scheduleMax: torontoLocal(new Date(now + 59 * 24 * 3600_000)),
    wa: {
      phoneOk: wa.on && !!wa.number,
      sentLabel: when(a.wa_sent_at),
      requested: !!a.wa_requested_at,
      reason: !PHONE_KINDS.has(a.kind) ? "Money decisions are made here only — never by phone."
        : !wa.number ? "Add your WhatsApp number in your profile to review on your phone."
        : !wa.on ? "WhatsApp is switched off in Connections." : null,
    },
    editable,
  };
}

export default async function Approvals({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  await requireOwnerPage();
  await expireStaleApprovals();
  const { type } = await searchParams;
  const [{ pending, whatsapp }, decided] = await Promise.all([getReviewItems(), getRecentDecisions(8)]);
  const now = Date.now();
  const filter = FILTERS.find((f) => f.key === type) ?? FILTERS[0];
  const shown = filter.kinds ? pending.filter((a) => (filter.kinds as readonly string[]).includes(a.kind)) : pending;
  const count = (k: (typeof FILTERS)[number]) => k.kinds ? pending.filter((a) => (k.kinds as readonly string[]).includes(a.kind)).length : pending.length;

  return (
    <>
      <header className="page-head rise">
        <div>
          <p className="eyebrow">Needs your OK</p>
          <h1>{pending.length ? `${pending.length} ${pending.length === 1 ? "item is" : "items are"} waiting for you` : "You're all caught up"}</h1>
          <p className="page-sub">See each post exactly as people will — on Instagram, Facebook, TikTok, LinkedIn or WhatsApp — then approve,
            schedule, decline, or send it to your phone. Nothing goes out, spends or books without your yes.</p>
        </div>
        <span className={`pill ${whatsapp.on && whatsapp.number ? "good" : "warn"}`}><Icon name="chat" /> WhatsApp {whatsapp.on && whatsapp.number ? `on · ${whatsapp.number}${whatsapp.auto ? " · sends automatically" : ""}` : "not ready"}</span>
      </header>

      <nav className="filters rise" aria-label="Filter">
        {FILTERS.map((f) => (
          <Link key={f.key} href={f.key === "all" ? "/approvals" : `/approvals?type=${f.key}`} className={`filter ${f === filter ? "on" : ""}`}
            aria-current={f === filter ? "page" : undefined}>{f.label} <span className="count">{count(f)}</span></Link>
        ))}
      </nav>

      {shown.length === 0 && <div className="empty-state rise"><Icon name="check" /><p>Nothing waiting here. New drafts from your team will appear as they're ready.</p></div>}
      <div className="reviews">
        {shown.map((a) => <ReviewCard key={a.id} a={toView(a, now, whatsapp)} />)}
      </div>

      {decided.length > 0 && (
        <section className="card rise" aria-labelledby="dec-title">
          <header className="card-head"><h2 id="dec-title">Recently decided</h2></header>
          <ul className="plain mini-list">
            {decided.map((d) => (
              <li key={d.id}><div><strong>{d.title}</strong>
                <span className="small"><span className={`chip chip-${d.status === "approved" ? "good" : d.status === "rejected" ? "critical" : "neutral"}`}>{d.status === "approved" ? "✓ Approved" : d.status === "rejected" ? "✕ Declined" : "⌛ Expired"}</span>
                  {d.decided_by ? ` by ${d.decided_by}` : ""}{d.decided_at ? ` · ${relative(d.decided_at, now)}` : ""}{d.decision_note ? ` · “${d.decision_note}”` : ""}</span></div></li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
