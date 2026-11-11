/**
 * Renders a storyboard to an MP4 on this machine. No paid service and no network: a headless browser draws each
 * frame of a self-contained page (fonts and logo embedded), and ffmpeg encodes the frames.
 *
 * The page shows only what the storyboard holds: every word and number comes from statements the owner approved.
 * Needs Playwright (`playwright-core` or `playwright` in node_modules, or PLAYWRIGHT_MODULE=<path to its index.mjs>)
 * with Chromium, and ffmpeg on the PATH (or FFMPEG_PATH).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Format, Scene, Storyboard } from "../../dashboard/lib/storyboard.ts";

const ROOT = join(import.meta.dirname, "../..");
export const SIZE: Record<Format, { w: number; h: number }> = { vertical: { w: 1080, h: 1920 }, wide: { w: 1920, h: 1080 } };

type Browser = { newPage(o: object): Promise<Page>; close(): Promise<void> };
type Page = { setContent(h: string, o?: object): Promise<void>; evaluate<T>(f: string | ((a: never) => T), a?: unknown): Promise<T>;
  screenshot(o: object): Promise<Buffer> };

export async function loadChromium(): Promise<{ launch(o?: object): Promise<Browser> }> {
  const tries = [process.env.PLAYWRIGHT_MODULE && pathToFileURL(process.env.PLAYWRIGHT_MODULE).href, "playwright-core", "playwright"].filter(Boolean) as string[];
  for (const t of tries) {
    try { return (await import(t)).chromium; } catch { /* try the next one */ }
  }
  throw new Error("Playwright is not installed. Run: npm install playwright-core@1.56.1 && npx playwright install chromium");
}

// Escapes for HTML, and keeps a minus sign on the same line as its amount ("−$164K").
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
  .replace(/([−–-])\$/g, "$1\u2060$");
const b64 = (p: string) => readFileSync(join(ROOT, p)).toString("base64");

function sceneHtml(s: Scene, i: number): string {
  const at = (t: number) => `data-at="${t}"`;
  switch (s.kind) {
    case "intro": return `<section class="scene intro">
      <img class="glass" ${at(0.2)} src="LOGO_GLASS" alt="">
      <p class="eyebrow" ${at(0.9)}>Trisanga · Collaboration &amp; education</p>
      <h1 ${at(1.3)}>This is <em>${esc(s.short)}'s</em> story.</h1>
      <p class="lead" ${at(2.1)}>${esc(s.name)}${s.place ? ` · ${esc(s.place)}` : ""}</p>
      <p class="small" ${at(2.7)}>Told from its own audited numbers, ${esc(s.years)}.</p></section>`;
    case "years": {
      const max = Math.max(1, ...s.items.map((x) => x.assets ?? 0));
      const bars = s.items.map((x, k) => `<div class="bar-col"><div class="bar" data-grow="${1 + k * 3.2}" data-h="${((x.assets ?? 0) / max) * 82}"></div>
        <span class="bar-val" ${at(1.6 + k * 3.2)}>${esc(x.assetsText ?? "")}</span><span class="bar-year">FY${x.year}</span></div>`).join("");
      const caps = s.items.map((x, k) => `<div class="cap" data-from="${1 + k * 3.2}" data-to="${k === s.items.length - 1 ? 999 : 1 + (k + 1) * 3.2}">
        <p class="year-card">FY${x.year}</p><p class="cap-text">${esc(x.text)}</p></div>`).join("");
      return `<section class="scene years"><p class="eyebrow" ${at(0.3)}>Where you've been</p><h2 ${at(0.5)}>Year by <em>year.</em></h2>
        <div class="chart">${bars}</div><div class="caps">${caps}</div><p class="chart-note" ${at(1)}>Assets, from audited financial statements</p></section>`;
    }
    case "trend": return `<section class="scene trend"><p class="eyebrow" ${at(0.3)}>Across the whole period</p><h2 ${at(0.5)}>${esc(s.title)}</h2>
      <div class="from-to"><div class="fig" ${at(1)}><span>${esc(s.from.label)} · FY${s.from.year}</span><strong>${esc(s.from.value)}</strong></div>
      <div class="arrow" ${at(1.6)}>→</div><div class="fig hi" ${at(2)}><span>${esc(s.to.label)} · FY${s.to.year}</span><strong>${esc(s.to.value)}</strong></div></div>
      <p class="lead" ${at(2.7)}>${esc(s.text)}</p></section>`;
    case "pain": return `<section class="scene pain"><p class="eyebrow warm" ${at(0.3)}>What's in the way</p><h2 ${at(0.6)}>${esc(s.title)}</h2>
      <div class="figs">${s.figures.map((f, k) => `<div class="fig ${k === s.figures.length - 1 ? "hi" : ""}" ${at(1.1 + k * 0.5)}><span>${esc(f.label)} · FY${f.year}</span><strong>${esc(f.value)}</strong></div>`).join("")}</div>
      <p class="lead" ${at(2.2)}>${esc(s.text)}</p></section>`;
    case "help": return `<section class="scene help"><p class="eyebrow" ${at(0.3)}>How Trisanga can help</p><h2 ${at(0.6)}>${esc(s.offering)}</h2>
      <p class="promise" ${at(1.2)}><em>${esc(s.promise)}</em></p><p class="lead" ${at(1.9)}>${esc(s.how)}</p>
      <p class="learn" ${at(2.8)}><span>What your team learns</span>${esc(s.learn)}</p></section>`;
    case "close": return `<section class="scene close"><img class="glass small-glass" ${at(0.2)} src="LOGO_GLASS" alt="">
      <p class="motto" ${at(0.8)}>Better questions. Practical innovation. Shared progress.</p>
      <h2 ${at(1.5)}>${esc(s.short)}, let's build it <em>together.</em></h2>
      <p class="values" ${at(2.2)}><span class="cur">Curiosity</span> · <span class="cre">Creativity</span> · <span class="col">Collaboration</span></p>
      <p class="small" ${at(2.8)}>TRISANGA · info@trisanga.ca</p><p class="sources" ${at(3.2)}>${esc(s.sources)}</p></section>`;
  }
  return `<!-- ${i} -->`;
}

export function pageHtml(sb: Storyboard, format: Format): string {
  const { w, h } = SIZE[format];
  const glass = `data:image/jpeg;base64,${b64("dashboard/public/brand/trisanga-glass.jpg")}`;
  const font = (f: string) => `url(data:font/woff2;base64,${b64(`dashboard/app/fonts/${f}`)}) format("woff2")`;
  const timeline = JSON.stringify(sb.scenes.map((s) => s.seconds));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Playfair;src:${font("PlayfairDisplay-latin.woff2")};font-weight:400 700;font-style:normal}
@font-face{font-family:Playfair;src:${font("PlayfairDisplay-italic-latin.woff2")};font-weight:400 700;font-style:italic}
@font-face{font-family:Jakarta;src:${font("PlusJakartaSans-latin.woff2")};font-weight:400 700}
*{box-sizing:border-box;margin:0}
html,body{width:${w}px;height:${h}px;overflow:hidden;background:#04272d;color:#f5f2eb;font-family:Jakarta,sans-serif}
.stage{position:relative;width:100%;height:100%;background:radial-gradient(circle at 1px 1px,rgba(255,255,255,.08) 1px,transparent 1.5px) 0 0/24px 24px,
  radial-gradient(1200px 900px at 80% 10%,#0e3b3d 0,transparent 60%),#04272d}
.scene{position:absolute;inset:0;padding:${format === "vertical" ? "200px 90px 240px" : "120px 160px 170px"};display:flex;flex-direction:column;justify-content:center;gap:${format === "vertical" ? 34 : 26}px;opacity:0}
[data-at]{opacity:0}
h1,h2{font-family:Playfair,serif;font-weight:400;letter-spacing:-.02em;line-height:1.08}
h1{font-size:${format === "vertical" ? 112 : 104}px}h2{font-size:${format === "vertical" ? 84 : 76}px}
em{font-style:italic;color:#dfc09a}
.eyebrow{font-size:${format === "vertical" ? 30 : 24}px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#c3d2c9}
.eyebrow.warm{color:#ff8a7e}
.lead{font-size:${format === "vertical" ? 44 : 38}px;line-height:1.38;color:#dbe4df;max-width:${format === "vertical" ? 900 : 1400}px}
.small{font-size:${format === "vertical" ? 30 : 26}px;color:#c3d2c9}
.glass{width:${format === "vertical" ? 520 : 380}px;height:auto;border-radius:40px;mask-image:radial-gradient(circle,#000 55%,transparent 72%);-webkit-mask-image:radial-gradient(circle,#000 55%,transparent 72%)}
.small-glass{width:${format === "vertical" ? 300 : 240}px}
.intro{align-items:flex-start}
.chart{flex:none;display:flex;align-items:flex-end;gap:${format === "vertical" ? 26 : 34}px;height:${format === "vertical" ? 620 : 330}px;padding-top:56px;border-bottom:2px solid rgba(255,255,255,.25)}
.bar-col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;position:relative}
.bar{width:72%;height:0;border-radius:14px 14px 4px 4px;background:linear-gradient(180deg,#4fb5ad,#1f8a82)}
.bar-val{position:absolute;top:2%;font-size:${format === "vertical" ? 28 : 24}px;font-weight:700;white-space:nowrap}
.bar-year{position:absolute;bottom:-46px;font-size:${format === "vertical" ? 28 : 24}px;color:#c3d2c9}
.chart-note{margin-top:${format === "vertical" ? 56 : 8}px;font-size:24px;color:#9fb5ad}
.caps{flex:none;position:relative;margin-top:${format === "vertical" ? 64 : 52}px;min-height:${format === "vertical" ? 300 : 170}px}
.cap{position:absolute;inset:0;opacity:0;display:flex;gap:28px;align-items:baseline;${format === "vertical" ? "flex-direction:column;gap:12px" : ""}}
.year-card{font-family:Playfair,serif;font-style:italic;font-size:${format === "vertical" ? 72 : 60}px;color:#dfc09a}
.cap-text{font-size:${format === "vertical" ? 40 : 34}px;line-height:1.4;color:#f5f2eb}
.from-to,.figs{display:flex;gap:36px;align-items:center;flex-wrap:wrap}
.fig{display:flex;flex-direction:column;gap:10px;padding:30px 38px;border-radius:28px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18)}
.fig span{font-size:${format === "vertical" ? 28 : 24}px;color:#c3d2c9}
.fig strong{font-family:Playfair,serif;font-weight:500;font-size:${format === "vertical" ? 96 : 84}px;line-height:1}
.fig.hi{background:rgba(223,192,154,.14);border-color:#dfc09a}
.arrow{font-size:64px;color:#dfc09a}
.promise{font-family:Playfair,serif;font-size:${format === "vertical" ? 56 : 50}px;line-height:1.2}
.learn{font-size:${format === "vertical" ? 34 : 30}px;line-height:1.4;color:#dbe4df;padding:24px 30px;border-left:6px solid #4fb5ad;background:rgba(79,181,173,.1);border-radius:6px 20px 20px 6px}
.learn span{display:block;font-size:22px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#4fb5ad;margin-bottom:8px}
.close{align-items:center;text-align:center}
.motto{font-family:Playfair,serif;font-style:italic;font-size:${format === "vertical" ? 40 : 36}px;color:#dbe4df}
.values{font-size:${format === "vertical" ? 34 : 30}px;font-weight:700}.cur{color:#ffd60a}.cre{color:#ff4136}.col{color:#4fb5ad}
.sources{font-size:20px;color:#9fb5ad;max-width:${format === "vertical" ? 860 : 1200}px;line-height:1.5}
.brandbar{position:absolute;left:0;right:0;bottom:0;padding:${format === "vertical" ? "0 90px 90px" : "0 160px 60px"};display:flex;justify-content:space-between;align-items:center;font-size:22px;color:#c3d2c9}
.brandbar b{font-family:Playfair,serif;font-weight:700;letter-spacing:.18em;color:#f5f2eb;font-size:26px}
.progress{position:absolute;left:0;bottom:0;height:8px;background:linear-gradient(90deg,#ffd60a,#ff4136,#4fb5ad);width:0}
</style></head><body><div class="stage">
${sb.scenes.map(sceneHtml).join("\n").replaceAll("LOGO_GLASS", glass)}
<div class="brandbar"><b>TRISANGA</b><span>${esc(sb.cuName)} · a story from ONCU Insights</span></div><div class="progress"></div>
</div><script>
const durs=${timeline}, total=durs.reduce((a,b)=>a+b,0), starts=durs.map((_, i)=>durs.slice(0,i).reduce((a,b)=>a+b,0));
const scenes=[...document.querySelectorAll('.scene')], clamp=(x)=>Math.max(0,Math.min(1,x)), ease=(x)=>1-Math.pow(1-x,3);
window.seek=(t)=>{
  scenes.forEach((el,i)=>{
    const l=t-starts[i], d=durs[i], last=i===scenes.length-1;
    const o=l<0||l>d+(last?99:0)?0:Math.min(clamp(l/0.45), last?1:clamp((d-l)/0.4));
    el.style.opacity=o; if(!o) return;
    el.querySelectorAll('[data-at]').forEach((x)=>{const k=ease(clamp((l-Number(x.dataset.at))/0.55)); x.style.opacity=k; x.style.transform='translateY('+(1-k)*28+'px)';});
    el.querySelectorAll('[data-grow]').forEach((x)=>{const k=ease(clamp((l-Number(x.dataset.grow))/0.8)); x.style.height=(k*Number(x.dataset.h))+'%';});
    el.querySelectorAll('[data-from]').forEach((x)=>{const a=Number(x.dataset.from),b=Number(x.dataset.to); const k=Math.min(clamp((l-a)/0.4),clamp((b-l)/0.3)); x.style.opacity=k;});
  });
  document.querySelector('.progress').style.width=(clamp(t/total)*100)+'%';
};
window.seek(0);
</script></body></html>`;
}

export interface RenderResult { bytes: number; sha256: string; seconds: number }

/** Renders to outPath (written to a temp file first, then renamed, so a half-written file is never visible). */
export async function renderVideo(sb: Storyboard, format: Format, outPath: string, opts: { fps?: number; maxSeconds?: number } = {}): Promise<RenderResult> {
  const fps = opts.fps ?? 25;
  const seconds = Math.min(sb.seconds, opts.maxSeconds ?? Infinity);
  const frames = Math.round(seconds * fps);
  const { w, h } = SIZE[format];
  const tmp = `${outPath}.part.mp4`;
  const chromium = await loadChromium();
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ff = spawn(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps),
    "-c:v", "mjpeg", "-i", "pipe:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", tmp],
  { stdio: ["pipe", "ignore", "pipe"] });
  let ffErr = "";
  ff.stderr!.on("data", (d: Buffer) => { ffErr += d.toString(); });
  const done = new Promise<void>((resolve, reject) => {
    ff.on("error", (e) => reject(new Error(`ffmpeg could not start (${e.message}). Install it, e.g. brew install ffmpeg.`)));
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${ffErr.slice(0, 400)}`))));
  });
  done.catch(() => { /* surfaced by the await below */ });
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.setContent(pageHtml(sb, format), { waitUntil: "load" });
    await page.evaluate("document.fonts.ready.then(() => true)");
    for (let f = 0; f < frames; f++) {
      await page.evaluate(`window.seek(${f / fps})`);
      const jpg = await page.screenshot({ type: "jpeg", quality: 90 });
      if (!ff.stdin!.write(jpg)) await new Promise((r) => ff.stdin!.once("drain", r));
    }
    ff.stdin!.end();
    await done;
  } catch (err) {
    ff.kill("SIGKILL");
    try { unlinkSync(tmp); } catch { /* nothing written */ }
    throw err;
  } finally {
    await browser.close();
  }
  renameSync(tmp, outPath);
  const buf = readFileSync(outPath);
  return { bytes: statSync(outPath).size, sha256: createHash("sha256").update(buf).digest("hex"), seconds: frames / fps };
}
