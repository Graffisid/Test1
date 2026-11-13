/**
 * Video render worker. Picks up queued story videos, renders each to an MP4 on this machine, and records the result.
 *
 *   npm run video:worker            # keeps running; checks the queue every few seconds
 *   npm run video:worker -- --once  # renders what's queued now, then exits
 *
 * Runs as the video login (VIDEO_DATABASE_URL): it can claim queued videos and record the outcome, nothing else.
 * It draws only the storyboard frozen at request time, so a video always matches what the owner approved.
 * Files go to VIDEO_DIR (default .videos/ in this repo, owner-only). Nothing is uploaded or sent anywhere.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { newClient } from "../src/lib/db.ts";
import { renderVideo } from "../src/video/render.ts";
import type { Format, Storyboard } from "../dashboard/lib/storyboard.ts";

export const videoDir = () => resolve(process.env.VIDEO_DIR || join(import.meta.dirname, "../.videos"));

export async function renderNext(client: ReturnType<typeof newClient>, dir = videoDir()): Promise<number | null> {
  await client.query("BEGIN");
  const { rows } = await client.query<{ id: string; cu_id: string; format: Format; storyboard: Storyboard }>(
    `SELECT id, cu_id, format, storyboard FROM videos WHERE status = 'queued' ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
  if (!rows.length) { await client.query("COMMIT"); return null; }
  const v = rows[0];
  await client.query(`UPDATE videos SET status = 'rendering', render_started_at = now(), error = NULL WHERE id = $1`, [v.id]);
  await client.query("COMMIT");
  const fileName = `${v.cu_id}-${v.id}-${v.format}.mp4`;
  try {
    const r = await renderVideo(v.storyboard, v.format, join(dir, fileName), {
      fps: Number(process.env.VIDEO_FPS) || 25,
      maxSeconds: process.env.VIDEO_MAX_SECONDS ? Number(process.env.VIDEO_MAX_SECONDS) : undefined });
    await client.query(`UPDATE videos SET status = 'ready', rendered_at = now(), file_name = $2, file_sha256 = $3, file_bytes = $4, duration_s = $5
                        WHERE id = $1`, [v.id, fileName, r.sha256, r.bytes, r.seconds]);
    console.log(`video-worker: #${v.id} ${v.cu_id} (${v.format}) ready — ${r.seconds}s, ${(r.bytes / 1e6).toFixed(1)} MB`);
  } catch (err) {
    const msg = (err as Error).message.slice(0, 900);
    await client.query(`UPDATE videos SET status = 'failed', error = $2 WHERE id = $1`, [v.id, msg]);
    console.error(`video-worker: #${v.id} failed — ${msg}`);
  }
  return Number(v.id);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = videoDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const client = newClient(process.env.VIDEO_DATABASE_URL || process.env.DATABASE_URL || undefined);
  await client.connect();
  const once = process.argv.includes("--once");
  let stop = false;
  process.on("SIGTERM", () => { stop = true; });
  process.on("SIGINT", () => { stop = true; });
  console.log(`video-worker: watching the queue; files go to ${dir}`);
  while (!stop) {
    const id = await renderNext(client, dir).catch((e) => { console.error(`video-worker: ${(e as Error).message}`); return null; });
    if (id === null) {
      if (once) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  await client.end();
}
