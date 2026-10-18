/**
 * Malware hygiene for generated media. Nothing a provider hands back is trusted:
 *
 *   * URLs: only our simulator's mock:// scheme or https on hosts the owner allow-listed (MEDIA_ALLOWED_HOSTS).
 *     No http, no IP addresses, no credentials in the URL, no odd ports.
 *   * Bytes (real adapters, before storing anything): the file must BE what it claims, judged by its magic
 *     bytes, not its name or content-type — PNG, JPEG or WebP pictures, MP4/MOV video, MP3/M4A/WAV audio —
 *     and within a size limit. Everything else is refused: SVG and HTML (can carry scripts), PDFs, archives,
 *     executables. Media is stored and served as a plain file, never opened, unpacked or run.
 */
export type MediaKind = "image" | "video" | "voiceover";

const LIMITS: Record<MediaKind, number> = { image: 10 * 1024 ** 2, video: 200 * 1024 ** 2, voiceover: 20 * 1024 ** 2 };

export function allowedHosts(): string[] {
  return (process.env.MEDIA_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

export function validateMediaUrl(raw: string, kind: MediaKind, hosts = allowedHosts()): { ok: boolean; reason?: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: "not a URL" }; }
  if (u.protocol === "mock:") {
    const folder = kind === "voiceover" ? "voice" : kind;
    return u.hostname === "media" && u.pathname.startsWith(`/${folder}/`) && /^[\w/.-]+$/.test(u.pathname) && !u.pathname.includes("..")
      ? { ok: true } : { ok: false, reason: "unexpected simulator URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "only https media URLs are accepted" };
  if (u.username || u.password) return { ok: false, reason: "credentials in URL" };
  if (u.port && u.port !== "443") return { ok: false, reason: "unexpected port" };
  if (/^[\d.]+$/.test(u.hostname) || u.hostname.includes(":")) return { ok: false, reason: "IP-address hosts are not accepted" };
  if (!hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return { ok: false, reason: `host ${u.hostname} is not on the allow-list` };
  return { ok: true };
}

const at = (b: Uint8Array, off: number, sig: number[]) => sig.every((x, i) => b[off + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function sniff(b: Uint8Array): string | null {
  if (at(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(b, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(b, 0, ascii("RIFF")) && at(b, 8, ascii("WEBP"))) return "image/webp";
  if (at(b, 0, ascii("RIFF")) && at(b, 8, ascii("WAVE"))) return "audio/wav";
  if (at(b, 4, ascii("ftyp"))) {
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (/^M4A /.test(brand)) return "audio/mp4";
    if (/^(isom|iso[2-6]|mp41|mp42|avc1|qt  |M4V )/.test(brand)) return "video/mp4";
    return null;
  }
  if (at(b, 0, ascii("ID3")) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  return null;
}

const ACCEPT: Record<MediaKind, string[]> = {
  image: ["image/png", "image/jpeg", "image/webp"],
  video: ["video/mp4"],
  voiceover: ["audio/mpeg", "audio/mp4", "audio/wav"],
};

export function validateMediaBytes(bytes: Uint8Array, kind: MediaKind): { ok: boolean; type?: string; reason?: string } {
  if (bytes.length < 16) return { ok: false, reason: "file too small to be media" };
  if (bytes.length > LIMITS[kind]) return { ok: false, reason: `file larger than ${Math.round(LIMITS[kind] / 1024 ** 2)} MB` };
  const type = sniff(bytes);
  if (!type || !ACCEPT[kind].includes(type)) return { ok: false, reason: `not an accepted ${kind} file${type ? ` (looks like ${type})` : ""}` };
  return { ok: true, type };
}
