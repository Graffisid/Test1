"use client";

import { useState } from "react";
import { Poster, posterTheme, type PosterFormat } from "./Poster";

export type Platform = "instagram" | "facebook" | "tiktok" | "linkedin" | "whatsapp";
const LABEL: Record<Platform, string> = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", linkedin: "LinkedIn", whatsapp: "WhatsApp" };

export interface PostView {
  uid: string; format: PosterFormat; headline: string; sub: string | null; caption: string; hashtags: string[]; cta: string | null;
  slides: number; sponsored: boolean; platform: Platform; scheduledLabel: string | null;
}

const HANDLE = "northshoreplumbing";

/** Hashtags in the platform's link colour; the rest plain. Text only — nothing here is HTML. */
function Caption({ text, tags, lead }: { text: string; tags: string[]; lead?: string }) {
  return (
    <p className="sp-caption">
      {lead && <strong>{lead} </strong>}
      {text}
      {tags.length > 0 && <> {tags.map((t) => <span key={t} className="sp-tag">{t} </span>)}</>}
    </p>
  );
}

/** How the post will look, platform by platform. Switching tabs changes the preview only, not where it posts. */
export function SocialPreview({ v }: { v: PostView }) {
  const [p, setP] = useState<Platform>(v.platform);
  const poster = <Poster uid={`${v.uid}-${p}`} headline={v.headline} sub={v.sub} format={v.format} theme={posterTheme(`${v.headline} ${v.caption}`)}
    cta={v.sponsored ? v.cta : null} slides={v.slides} tall={p === "tiktok"} />;
  return (
    <div className="sp">
      <div className="sp-tabs" role="tablist" aria-label="Preview on">
        {(Object.keys(LABEL) as Platform[]).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={p === k} className={`sp-tab t-${k}`} onClick={() => setP(k)}>
            {LABEL[k]}{k === v.platform && <span className="sp-target" title="Where this will post"> ●</span>}
          </button>
        ))}
      </div>
      <div className={`sp-frame f-${p}`}>
        {p === "instagram" && (
          <div className="ig">
            <header className="sp-head"><span className="sp-av">N</span><span><strong>{HANDLE}</strong>{v.sponsored ? <small>Sponsored</small> : <small>Burlington, Ontario</small>}</span><span className="sp-more">•••</span></header>
            <div className="sp-media">{poster}</div>
            {v.sponsored && v.cta && <div className="ig-cta">{v.cta} <span>›</span></div>}
            <div className="ig-actions" aria-hidden="true"><span>♡</span><span>💬</span><span>➤</span><span className="ig-save">⌑</span></div>
            <Caption text={v.caption} tags={v.hashtags} lead={HANDLE} />
            <p className="sp-muted">No comments yet · preview</p>
          </div>
        )}
        {p === "facebook" && (
          <div className="fb">
            <header className="sp-head"><span className="sp-av">N</span><span><strong>Northshore Plumbing &amp; Heating</strong><small>{v.sponsored ? "Sponsored · 🌐" : `${v.scheduledLabel ?? "Scheduled"} · 🌐`}</small></span><span className="sp-more">•••</span></header>
            <Caption text={v.caption} tags={v.hashtags} />
            <div className="sp-media">{poster}</div>
            {v.sponsored && (
              <div className="fb-link"><span><small>NORTHSHOREPLUMBING.CA</small><strong>{v.headline}</strong></span>{v.cta && <span className="fb-btn">{v.cta}</span>}</div>
            )}
            <div className="fb-actions" aria-hidden="true"><span>👍 Like</span><span>💬 Comment</span><span>↗ Share</span></div>
          </div>
        )}
        {p === "tiktok" && (
          <div className="tt">
            <div className="tt-media">{poster}</div>
            <div className="tt-rail" aria-hidden="true"><span className="sp-av">N</span><span>♥</span><span>💬</span><span>↗</span></div>
            <div className="tt-text">
              <strong>@{HANDLE}</strong>
              <p>{v.caption.length > 140 ? `${v.caption.slice(0, 140)}…` : v.caption} {v.hashtags.slice(0, 4).join(" ")}</p>
              <p className="tt-sound">♫ Original sound · Northshore</p>
            </div>
            {v.format === "reel" && <div className="tt-progress"><span /></div>}
          </div>
        )}
        {p === "linkedin" && (
          <div className="li">
            <header className="sp-head"><span className="sp-av sq">N</span><span><strong>Northshore Plumbing &amp; Heating</strong><small>Plumbing &amp; HVAC · Burlington{v.sponsored ? " · Promoted" : ""}</small></span><span className="sp-more">•••</span></header>
            <Caption text={v.caption} tags={v.hashtags.slice(0, 3)} />
            <div className="sp-media">{poster}</div>
            <div className="li-actions" aria-hidden="true"><span>👍 Like</span><span>💬 Comment</span><span>🔁 Repost</span><span>➤ Send</span></div>
          </div>
        )}
        {p === "whatsapp" && (
          <div className="wa-chat">
            <div className="wa-top"><span className="sp-av">N</span><span><strong>Northshore AI team</strong><small>only your replies count</small></span></div>
            <div className="wa-bubble">
              <div className="sp-media">{poster}</div>
              <p><strong>{v.format === "reel" ? "🎬 New reel" : v.format === "carousel" ? "🖼️ New carousel" : v.sponsored ? "📣 New ad" : "📷 New post"} — ready for your OK</strong></p>
              <p>{v.caption.length > 220 ? `${v.caption.slice(0, 220)}…` : v.caption}</p>
              {v.scheduledLabel && <p>Posts: {v.scheduledLabel}</p>}
              <p>Reply <strong>APPROVE ••••••</strong> or <strong>REJECT ••••••</strong></p>
              <span className="wa-time">now ✓✓</span>
            </div>
          </div>
        )}
      </div>
      <p className="sp-note">Preview · {LABEL[p]}{p === v.platform ? " — this is where it posts" : ` — it posts on ${LABEL[v.platform]}`}</p>
    </div>
  );
}

/** A Google review with your drafted public reply under it. */
export function ReviewReplyPreview({ review, reply, stars }: { review: string; reply: string; stars: number }) {
  return (
    <div className="gr">
      <header className="gr-head"><span className="gr-g">G</span><strong>Google review</strong></header>
      <div className="gr-review">
        <span className="sp-av c">C</span>
        <div><strong>Customer</strong><span className="gr-stars" aria-label={`${stars} out of 5 stars`}>{"★".repeat(stars)}<span>{"★".repeat(5 - stars)}</span></span><p>{review}</p></div>
      </div>
      <div className="gr-reply"><strong>Response from the owner</strong><p>{reply}</p></div>
    </div>
  );
}
