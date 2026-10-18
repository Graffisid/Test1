/**
 * A poster for a post or ad, drawn as SVG from the draft's own (already checked) words plus the business's
 * verified facts only — so the picture can never add a claim the safety checks didn't see. Real photography or
 * AI images replace this once an image provider is connected; until then this is what gets reviewed.
 */
export type PosterTheme = "heat" | "water" | "brand";
export type PosterFormat = "reel" | "carousel" | "image_post" | "ad";

export function posterTheme(text: string): PosterTheme {
  if (/furnace|heat|cold|winter|tune-?up|thermostat|hvac/i.test(text)) return "heat";
  if (/water|drain|pipe|leak|plumb|sink|toilet|sewer/i.test(text)) return "water";
  return "brand";
}

const THEMES: Record<PosterTheme, { from: string; to: string; accent: string; ink: string }> = {
  heat: { from: "#2a1205", to: "#b4471a", accent: "#f2b33d", ink: "#fff7ec" },
  water: { from: "#062a33", to: "#0e7c86", accent: "#7fe0e7", ink: "#f0fbfc" },
  brand: { from: "#10202b", to: "#0b5f67", accent: "#e0a43a", ink: "#f4f8f7" },
};

// Icon silhouettes (24×24 paths), drawn huge and faint behind the words.
const FLAME = "M12 2c1 3.5 5 6 5 11a5 5 0 0 1-10 0c0-2.5 1.2-4 2.5-5.5C9.7 9.5 11 11 12 11c0-3-1.5-5.5 0-9Z";
const DROP = "M12 2.5C9 7 6 10.3 6 14a6 6 0 0 0 12 0c0-3.7-3-7-6-11.5Z";
const WRENCH = "M21 6.5a5 5 0 0 1-6.6 4.7L6 19.6a2 2 0 0 1-2.8-2.8l8.4-8.4A5 5 0 0 1 17.5 2l-3 3 1 3.5 3.5 1 3-3Z";

export function wrapWords(text: string, max: number, lines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max && cur) { out.push(cur); cur = w; } else cur = (cur + " " + w).trim();
    if (out.length === lines) break;
  }
  if (out.length < lines && cur) out.push(cur);
  if (out.length === lines && words.join(" ").length > out.join(" ").length) out[lines - 1] = out[lines - 1].replace(/\W*\s*\S*$/, "") + "…";
  return out;
}

export function Poster({ uid, headline, sub, format, theme, cta, slides = 0, tall = false }: {
  uid: string; headline: string; sub?: string | null; format: PosterFormat; theme: PosterTheme; cta?: string | null; slides?: number;
  /** 9:16 for TikTok/Reels: the words sit higher and narrower, clear of the app's caption and side buttons. */
  tall?: boolean;
}) {
  const t = THEMES[theme];
  const H = tall ? 1920 : 1350;
  const lines = wrapWords(headline.replace(/[“”"]/g, ""), tall ? 13 : 15, 4);
  const size = lines.length > 3 ? 86 : 100;
  const top = (tall ? 720 : 560) - (lines.length * size) / 2;
  const ctaY = tall ? 1180 : 1092, footY = tall ? 1350 : 1262;
  const subLines = sub ? wrapWords(sub, 34, 2) : [];
  const icon = theme === "heat" ? FLAME : theme === "water" ? DROP : WRENCH;
  return (
    <svg viewBox={`0 0 1080 ${H}`} className="poster" role="img" aria-label={`Poster: ${headline}`} preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id={`bg-${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={t.from} />
          <stop offset="1" stopColor={t.to} />
        </linearGradient>
        <radialGradient id={`glow-${uid}`} cx="0.85" cy="0.15" r="0.7">
          <stop offset="0" stopColor={t.accent} stopOpacity="0.45" />
          <stop offset="1" stopColor={t.accent} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1080" height={H} fill={`url(#bg-${uid})`} />
      <rect width="1080" height={H} fill={`url(#glow-${uid})`} />
      <path d={icon} transform={`translate(560 ${tall ? 900 : 640}) scale(26)`} fill={t.ink} opacity="0.07" />
      <circle cx="960" cy={H - 120} r="260" fill="none" stroke={t.accent} strokeOpacity="0.18" strokeWidth="2" />
      <circle cx="960" cy={H - 120} r="190" fill="none" stroke={t.accent} strokeOpacity="0.12" strokeWidth="2" />

      <g transform={`translate(80 ${tall ? 150 : 92})`}>
        <rect width="74" height="74" rx="20" fill={t.accent} />
        <text x="37" y="51" textAnchor="middle" className="poster-logo" fill={t.from}>N</text>
        <text x="100" y="34" className="poster-brand" fill={t.ink}>NORTHSHORE</text>
        <text x="100" y="66" className="poster-brand-sub" fill={t.ink} opacity="0.75">PLUMBING &amp; HEATING · BURLINGTON</text>
      </g>
      {format === "reel" && (
        <g transform={`translate(${tall ? 760 : 830} ${tall ? 150 : 92})`}>
          <rect width="170" height="64" rx="32" fill={t.ink} opacity="0.16" />
          <path d="M34 18 L58 32 L34 46 Z" fill={t.ink} />
          <text x="72" y="42" className="poster-badge" fill={t.ink}>REEL</text>
        </g>
      )}
      {format === "ad" && (
        <g transform={`translate(${tall ? 740 : 800} ${tall ? 150 : 92})`}>
          <rect width="200" height="64" rx="32" fill={t.ink} opacity="0.16" />
          <text x="100" y="42" textAnchor="middle" className="poster-badge" fill={t.ink}>FALL 2026</text>
        </g>
      )}

      <rect x="80" y={top - size - 40} width="120" height="10" rx="5" fill={t.accent} />
      {lines.map((l, i) => (
        <text key={i} x="80" y={top + i * size * 1.08} className="poster-head" fontSize={size} fill={t.ink}>{l}</text>
      ))}
      {subLines.map((l, i) => (
        <text key={i} x="80" y={top + lines.length * size * 1.08 + 40 + i * 52} className="poster-sub" fill={t.ink} opacity="0.85">{l}</text>
      ))}

      <g transform={`translate(80 ${ctaY})`}>
        <rect width={cta ? 600 : 520} height="110" rx="55" fill={t.accent} />
        <text x={cta ? 300 : 260} y="70" textAnchor="middle" className="poster-cta" fill={t.from}>{cta ? cta : "Call (905) 555-0100"}</text>
      </g>
      <text x="80" y={footY} className="poster-foot" fill={t.ink} opacity="0.8">Licensed &amp; insured · 24/7 emergency line · (905) 555-0100</text>
      {format === "carousel" && slides > 1 && (
        <g transform={`translate(${540 - (slides * 28) / 2} ${H - 40})`}>
          {Array.from({ length: slides }, (_, i) => <circle key={i} cx={i * 28 + 10} cy="0" r="8" fill={t.ink} opacity={i === 0 ? 1 : 0.35} />)}
        </g>
      )}
    </svg>
  );
}
