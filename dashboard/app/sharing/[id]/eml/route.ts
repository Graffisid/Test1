/**
 * Downloads the email file the mailer wrote for a sent share, for the signed-in owner only.
 * The file is found by the share's id in OUTBOX_DIR (never a path from the request).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { q } from "@/lib/db";
import { isOwner } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isOwner())) return new Response("Sign in first.", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id < 1) return new Response("Not found.", { status: 404 });
  const [s] = await q<{ status: string; cu_id: string }>(`SELECT s.status, v.cu_id FROM shares s JOIN videos v ON v.id = s.video_id WHERE s.id = $1`, [id]);
  if (s?.status !== "sent") return new Response("Not found.", { status: 404 });
  let data: Buffer;
  try { data = readFileSync(join(resolve(process.env.OUTBOX_DIR || join(process.cwd(), "../.outbox")), `share-${id}.eml`)); }
  catch { return new Response("The email file is missing from the outbox.", { status: 410 }); }
  return new Response(new Uint8Array(data), { headers: { "content-type": "message/rfc822", "content-disposition": `attachment; filename="trisanga-${s.cu_id}-message-${id}.eml"`,
    "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}
