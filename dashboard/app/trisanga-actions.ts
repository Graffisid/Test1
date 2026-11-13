"use server";

/**
 * Owner decisions for the Trisanga story platform.
 *   - Approving a claim: the server rebuilds the story from the database and approves the claim it finds,
 *     pinned to that claim's hash. The browser never supplies the text or the hash.
 *   - Offerings and pain-point mapping: column-limited updates (see migration 023).
 */
import { revalidatePath } from "next/cache";
import { OWNER_NAME, q } from "@/lib/db";
import { getCuStory } from "@/lib/oncu";
import { buildStoryboard } from "@/lib/storyboard";
import { requireOwner } from "@/lib/session";
import type { ActionState } from "@/lib/action-state";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function decideClaimAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  await requireOwner();
  const cuId = str(form, "cu_id"), key = str(form, "claim_key"), decision = str(form, "decision"), note = str(form, "note").slice(0, 500) || null;
  if (!/^[a-z0-9-]{2,40}$/.test(cuId) || !/^[a-z0-9:-]{2,80}$/.test(key) || !["approved", "rejected"].includes(decision)) {
    return { ok: false, message: "That request wasn't valid." };
  }
  const s = await getCuStory(cuId);
  const claim = s && [...s.story.chapters, ...s.story.trends, ...s.story.pains].find((c) => c.key === key);
  if (!s || !claim) return { ok: false, message: "That statement no longer exists. ONCU's numbers may have changed; reload the page." };
  if (s.state(claim) === decision) return { ok: true, message: decision === "approved" ? "Already approved." : "Already set aside." };
  await q(`INSERT INTO claim_approvals (cu_id, claim_key, claim_hash, claim_text, decision, note, decided_by, import_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [cuId, key, claim.hash, claim.text, decision, note, OWNER_NAME, s.cu.last_import_id]);
  revalidatePath(`/credit-unions/${cuId}`);
  return { ok: true, message: decision === "approved" ? "Approved for stories and videos." : "Set aside. It won't be used." };
}

export async function approveAllAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  await requireOwner();
  const cuId = str(form, "cu_id"), kind = str(form, "kind");
  if (!/^[a-z0-9-]{2,40}$/.test(cuId) || !["chapter", "trend", "pain"].includes(kind)) return { ok: false, message: "That request wasn't valid." };
  const s = await getCuStory(cuId);
  if (!s) return { ok: false, message: "Credit union not found." };
  const waiting = [...s.story.chapters, ...s.story.trends, ...s.story.pains].filter((c) => c.kind === kind && s.state(c) === "waiting");
  for (const c of waiting) {
    await q(`INSERT INTO claim_approvals (cu_id, claim_key, claim_hash, claim_text, decision, decided_by, import_id)
             VALUES ($1, $2, $3, $4, 'approved', $5, $6)`, [cuId, c.key, c.hash, c.text, OWNER_NAME, s.cu.last_import_id]);
  }
  revalidatePath(`/credit-unions/${cuId}`);
  return { ok: true, message: waiting.length ? `Approved ${waiting.length} statement${waiting.length === 1 ? "" : "s"}.` : "Nothing was waiting." };
}

const LIMITS = { title: [2, 80], promise: [2, 200], how_we_help: [2, 800], learn: [2, 400] } as const;

export async function saveOfferingAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  await requireOwner();
  const key = str(form, "key");
  if (!/^[a-z0-9-]{2,40}$/.test(key)) return { ok: false, message: "Unknown offering." };
  const vals: Record<string, string> = {};
  for (const [f, [min, max]] of Object.entries(LIMITS)) {
    const v = str(form, f);
    if (v.length < min || v.length > max) return { ok: false, message: `${f === "how_we_help" ? "How we help" : f[0].toUpperCase() + f.slice(1)} must be ${min}–${max} characters.` };
    vals[f] = v;
  }
  const active = form.get("active") === "on";
  const rows = await q(`UPDATE offerings SET title = $2, promise = $3, how_we_help = $4, learn = $5, active = $6, updated_by = $7 WHERE key = $1 RETURNING key`,
    [key, vals.title, vals.promise, vals.how_we_help, vals.learn, active, OWNER_NAME]);
  if (!rows.length) return { ok: false, message: "Unknown offering." };
  revalidatePath("/offerings");
  return { ok: true, message: `Saved "${vals.title}".` };
}

export async function mapRuleAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  await requireOwner();
  const rule = str(form, "rule"), offering = str(form, "offering_key");
  const active = form.get("active") === "on";
  if (!/^[a-z0-9-]{2,40}$/.test(rule) || !/^[a-z0-9-]{2,40}$/.test(offering)) return { ok: false, message: "That request wasn't valid." };
  const rows = await q(`UPDATE pain_rules SET offering_key = $2, active = $3, updated_by = $4 WHERE key = $1
                        AND EXISTS (SELECT 1 FROM offerings WHERE key = $2) RETURNING key`, [rule, offering, active, OWNER_NAME]);
  if (!rows.length) return { ok: false, message: "Unknown pain point or offering." };
  revalidatePath("/offerings");
  return { ok: true, message: "Mapping saved." };
}

/** Freezes a storyboard from the approved statements and queues it for the render worker. */
export async function requestVideoAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  await requireOwner();
  const cuId = str(form, "cu_id"), format = str(form, "format");
  if (!/^[a-z0-9-]{2,40}$/.test(cuId) || !["vertical", "wide"].includes(format)) return { ok: false, message: "That request wasn't valid." };
  const s = await getCuStory(cuId);
  if (!s) return { ok: false, message: "Credit union not found." };
  const built = buildStoryboard({ cu: s.cu, story: s.story, offerings: s.offerings, approved: (c) => s.state(c) === "approved" });
  if ("missing" in built) return { ok: false, message: `Not ready yet: ${built.missing.join("; ")}.` };
  const busy = await q(`SELECT 1 FROM videos WHERE cu_id = $1 AND format = $2 AND status IN ('queued', 'rendering')`, [cuId, format]);
  if (busy.length) return { ok: false, message: "A video in that format is already being made." };
  try {
    await q(`INSERT INTO videos (cu_id, format, storyboard, claims, import_id, requested_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [cuId, format, JSON.stringify(built.storyboard), JSON.stringify(built.claims), s.cu.last_import_id, OWNER_NAME]);
  } catch (err) {
    return { ok: false, message: (err as Error).message.includes("approved") ? "A statement changed before the video was queued. Reload and try again." : "Couldn't queue the video." };
  }
  revalidatePath(`/credit-unions/${cuId}`);
  revalidatePath("/videos");
  return { ok: true, message: `Queued a ${format === "vertical" ? "vertical (9:16)" : "wide (16:9)"} video. It takes about a minute or two to render.` };
}

export async function decideVideoAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  await requireOwner();
  const id = Number(str(form, "id")), decision = str(form, "decision"), note = str(form, "note").slice(0, 500) || null;
  if (!Number.isSafeInteger(id) || id < 1 || !["approved", "rejected", "retry"].includes(decision)) return { ok: false, message: "That request wasn't valid." };
  const [v] = await q<{ cu_id: string; status: string; claims: { key: string; hash: string }[] }>(`SELECT cu_id, status, claims FROM videos WHERE id = $1`, [id]);
  if (!v) return { ok: false, message: "Video not found." };
  if (decision === "retry") {
    if (v.status !== "failed") return { ok: false, message: "Only a failed video can be tried again." };
    await q(`UPDATE videos SET status = 'queued', error = NULL WHERE id = $1`, [id]);
  } else {
    if (v.status !== "ready" && !(decision === "rejected" && ["queued", "failed"].includes(v.status))) {
      return { ok: false, message: "This video can't be decided right now." };
    }
    if (decision === "approved") {
      // The numbers must still be ONCU's current ones, not just approved at the time.
      const s = await getCuStory(v.cu_id);
      const current = new Map([...(s?.story.chapters ?? []), ...(s?.story.trends ?? []), ...(s?.story.pains ?? [])].map((c) => [c.key, c.hash]));
      if (v.claims.some((c) => current.get(c.key) !== c.hash)) {
        return { ok: false, message: "ONCU's numbers changed since this video was made. Review the statements and make a new video." };
      }
    }
    try {
      await q(`UPDATE videos SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`, [id, decision, OWNER_NAME, note]);
    } catch (err) {
      return { ok: false, message: (err as Error).message.includes("no longer approved") ? "A statement in this video is no longer approved. Make a new video." : "Couldn't save that decision." };
    }
  }
  revalidatePath("/videos");
  revalidatePath(`/credit-unions/${v.cu_id}`);
  return { ok: true, message: decision === "approved" ? "Video approved. It's ready to download." : decision === "retry" ? "Queued again." : "Video declined." };
}
