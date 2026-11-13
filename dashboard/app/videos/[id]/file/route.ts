/**
 * Streams a rendered video to the signed-in owner (the proxy also requires a session for this path).
 * Only a file recorded on a ready/approved video row is served, by its database name, from VIDEO_DIR — never a path from the request.
 * Supports HTTP Range so the player can seek. ?download=1 saves it (approved videos only).
 */
import { createReadStream, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { q } from "@/lib/db";
import { isOwner } from "@/lib/session";

export const dynamic = "force-dynamic";

const dir = () => resolve(process.env.VIDEO_DIR || join(process.cwd(), "../.videos"));

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isOwner())) return new Response("Sign in first.", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id < 1) return new Response("Not found.", { status: 404 });
  const [v] = await q<{ file_name: string | null; status: string; cu_id: string; format: string }>(
    `SELECT file_name, status, cu_id, format FROM videos WHERE id = $1`, [id]);
  if (!v?.file_name || !/^[a-z0-9-]{1,80}\.mp4$/.test(v.file_name) || !["ready", "approved"].includes(v.status)) {
    return new Response("Not found.", { status: 404 });
  }
  const download = new URL(req.url).searchParams.get("download") === "1";
  if (download && v.status !== "approved") return new Response("Approve the video before downloading it.", { status: 403 });
  const path = join(dir(), v.file_name);
  let size: number;
  try { size = statSync(path).size; } catch { return new Response("The video file is missing. Make the video again.", { status: 410 }); }

  const headers: Record<string, string> = {
    "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    ...(download ? { "content-disposition": `attachment; filename="trisanga-${v.cu_id}-${v.format}-${id}.mp4"` } : {}),
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start); end = Math.min(size - 1, end);
    if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return new Response(body, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { status: 200, headers: { ...headers, "content-length": String(size) } });
}
