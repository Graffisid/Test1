import "server-only";
import { q } from "./db";
import { approvalFor, buildStory, type Claim, type MetricValue, type Rule, type Story } from "./story";

export interface ImportRow { id: number; source_commit: string | null; roster_verified: string | null; cu_count: number; metric_count: number; fact_count: number; imported_at: string }
export interface CuRow {
  id: string; name: string; short_name: string; legal_name: string | null; city: string | null; website: string | null; head_office: string | null;
  ceo: string | null; chair: string | null; branches: number | null; members: number | null; reporting_year: number | null; as_of: string | null;
  data_tier: string | null; caveat: string | null; brand_primary: string | null; executive_title: string | null; executive_summary: string | null;
  last_import_id: number;
}
export interface Offering { key: string; title: string; promise: string; how_we_help: string; learn: string; sort: number; active: boolean; updated_by: string | null; updated_at: string }
export interface Decision { claim_key: string; claim_hash: string; decision: "approved" | "rejected"; decided_by: string; decided_at: string; note: string | null }
export type ClaimState = "approved" | "rejected" | "waiting";

export async function getImports(): Promise<ImportRow[]> {
  return q<ImportRow>(`SELECT id, source_commit, roster_verified::text, cu_count, metric_count, fact_count, imported_at FROM oncu_imports ORDER BY id DESC`);
}
export const getRules = () => q<Rule>(`SELECT key, title, test, offering_key, active FROM pain_rules ORDER BY key`);
export const getOfferings = () => q<Offering>(`SELECT * FROM offerings ORDER BY sort, key`);

/** Metric values from the latest import that includes this credit union (or a given earlier import). */
async function metrics(cuId: string, importId?: number): Promise<MetricValue[]> {
  return q<MetricValue>(
    `SELECT year, metric, value::float8 AS value, classification, source_ids FROM cu_metric_values
     WHERE cu_id = $1 AND import_id = COALESCE($2, (SELECT max(import_id) FROM cu_metric_values WHERE cu_id = $1))`,
    [cuId, importId ?? null]);
}

export interface CuStory {
  cu: CuRow; story: Story; rules: Rule[]; offerings: Offering[];
  decisions: Decision[]; state: (c: Claim) => ClaimState;
  sources: { source_key: string; label: string; url: string | null; kind: string | null; year: string | null }[];
  history: { import_id: number; imported_at: string; changed: number; first: boolean }[];
}

export async function getCuStory(id: string): Promise<CuStory | null> {
  const [cu] = await q<CuRow>(`SELECT * FROM credit_unions WHERE id = $1`, [id]);
  if (!cu) return null;
  const [values, rules, offerings, decisions, sources, history] = await Promise.all([
    metrics(id), getRules(), getOfferings(),
    q<Decision>(`SELECT claim_key, claim_hash, decision, decided_by, decided_at, note FROM claim_approvals WHERE cu_id = $1 ORDER BY decided_at DESC`, [id]),
    q<CuStory["sources"][number]>(`SELECT source_key, label, url, kind, year FROM cu_sources WHERE cu_id = $1 AND import_id = $2 ORDER BY source_key`, [id, cu.last_import_id]),
    // For each import that included this credit union: how many numbers are new, changed or gone since the one before.
    q<{ import_id: number; imported_at: string; changed: number; first: boolean }>(
      `WITH o AS (SELECT import_id, lag(import_id) OVER (ORDER BY import_id) AS prev
                  FROM (SELECT DISTINCT import_id FROM cu_metric_values WHERE cu_id = $1) d)
       SELECT o.import_id, i.imported_at, o.prev IS NULL AS first,
         ((SELECT count(*) FROM (SELECT year, metric, value FROM cu_metric_values WHERE cu_id = $1 AND import_id = o.import_id
                                 EXCEPT SELECT year, metric, value FROM cu_metric_values WHERE cu_id = $1 AND import_id = o.prev) x)
        + (SELECT count(*) FROM (SELECT year, metric FROM cu_metric_values WHERE cu_id = $1 AND import_id = o.prev
                                 EXCEPT SELECT year, metric FROM cu_metric_values WHERE cu_id = $1 AND import_id = o.import_id) y))::int AS changed
       FROM o JOIN oncu_imports i ON i.id = o.import_id ORDER BY o.import_id DESC`, [id]),
  ]);
  const story = buildStory(cu.short_name, values, rules);
  const state = (c: Claim): ClaimState => (approvalFor(c, decisions)?.decision as ClaimState | undefined) ?? "waiting";
  return { cu, story, rules, offerings, decisions, state, sources, history };
}

export interface CuSummary extends CuRow { years: number; pains: { key: string; title: string; offering_key: string }[]; claims: number; approved: number; waiting: number; stale: number; enough: boolean; latest_assets: number | null }

/** Every credit union with its story status, for the list and the overview. */
export async function getPortfolio(): Promise<CuSummary[]> {
  const [cus, rules, values, decisions] = await Promise.all([
    q<CuRow>(`SELECT * FROM credit_unions ORDER BY name`),
    getRules(),
    q<MetricValue & { cu_id: string }>(
      `SELECT v.cu_id, v.year, v.metric, v.value::float8 AS value, v.classification, v.source_ids FROM cu_metric_values v
       WHERE v.import_id = (SELECT max(import_id) FROM cu_metric_values w WHERE w.cu_id = v.cu_id)`),
    q<Decision & { cu_id: string }>(`SELECT cu_id, claim_key, claim_hash, decision, decided_by, decided_at, note FROM claim_approvals`),
  ]);
  const byCu = new Map<string, MetricValue[]>();
  for (const v of values) (byCu.get(v.cu_id) ?? byCu.set(v.cu_id, []).get(v.cu_id)!).push(v);
  return cus.map((cu) => {
    const s = buildStory(cu.short_name, byCu.get(cu.id) ?? [], rules);
    const claims = [...s.chapters, ...s.trends, ...s.pains];
    const ds = decisions.filter((d) => d.cu_id === cu.id);
    const assets = s.series.assets?.at(-1)?.value ?? null;
    return { ...cu, years: s.years.length, enough: s.enough, latest_assets: assets, claims: claims.length,
      approved: claims.filter((c) => approvalFor(c, ds)?.decision === "approved").length,
      waiting: s.enough ? claims.filter((c) => !approvalFor(c, ds)).length : 0,
      // Approved before, but ONCU's numbers have changed since: back to "waiting" until the owner looks again.
      stale: claims.filter((c) => !approvalFor(c, ds) && ds.some((d) => d.claim_key === c.key && d.decision === "approved")).length,
      pains: s.pains.map((p) => ({ key: p.rule, title: p.title, offering_key: p.offering_key })) };
  });
}

/** ONCU evidence records for one credit union in its latest import, grouped for the "context" panel. */
export async function getFacts(cuId: string, importId: number) {
  return q<{ fact_id: string; category: string | null; finding: string; value: string | null; period: string | null; source_url: string | null;
    source_document: string | null; data_type: string | null; verification_status: string | null; oncu_approval: string | null }>(
    `SELECT fact_id, category, finding, value, period, source_url, source_document, data_type, verification_status, oncu_approval
     FROM cu_facts WHERE cu_id = $1 AND import_id = $2 ORDER BY category, fact_id`, [cuId, importId]);
}

/** Story statements waiting for the owner's decision (credit unions with a full story only). */
export async function getWaitingCount(): Promise<number> {
  return (await getPortfolio()).reduce((n, c) => n + c.waiting, 0);
}

export interface VideoRow {
  id: number; cu_id: string; cu_name: string; format: "vertical" | "wide"; status: string; storyboard: import("./storyboard").Storyboard;
  claims: { key: string; hash: string }[]; requested_by: string; requested_at: string; rendered_at: string | null; file_name: string | null;
  file_bytes: number | null; duration_s: number | null; error: string | null; decided_by: string | null; decided_at: string | null; decision_note: string | null;
}

export async function getVideos(cuId?: string): Promise<VideoRow[]> {
  return q<VideoRow>(
    `SELECT v.id, v.cu_id, c.name AS cu_name, v.format, v.status, v.storyboard, v.claims, v.requested_by, v.requested_at, v.rendered_at,
            v.file_name, v.file_bytes, v.duration_s::float8 AS duration_s, v.error, v.decided_by, v.decided_at, v.decision_note
     FROM videos v JOIN credit_unions c ON c.id = v.cu_id WHERE ($1::text IS NULL OR v.cu_id = $1) ORDER BY v.requested_at DESC LIMIT 200`, [cuId ?? null]);
}

export async function getVideoReviewCount(): Promise<number> {
  const [r] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM videos WHERE status = 'ready'`);
  return r?.n ?? 0;
}

// ── Sharing and learning (migration 004) ──────────────────────────────────────────────────────
export interface SenderProfile { sender_name: string; title: string; organization: string; email: string; mailing_address: string; website: string; updated_by: string | null }
export interface ContactRow { id: number; cu_id: string; full_name: string; role_title: string; email: string; consent_basis: "express" | "published" | "relationship";
  consent_evidence: string; consent_date: string; added_by: string; added_at: string; unsubscribed_at: string | null; sendable: boolean }
export interface LessonRow { key: string; title: string; summary: string; body: string; rule_key: string | null; status: "draft" | "published"; sort: number; updated_by: string | null }
export interface ShareRow { id: number; video_id: number; contact_id: number; cu_id: string; cu_name: string; cu_short: string; contact_name: string; contact_email: string; format: string;
  subject: string; body: string; lesson_keys: string[]; status: string; created_at: string; approved_by: string | null; approved_at: string | null;
  sent_at: string | null; delivery_ref: string | null; error: string | null; outcome: string; outcome_note: string | null; unsubscribed: boolean }

export const getSender = async () => (await q<SenderProfile>(`SELECT sender_name, title, organization, email, mailing_address, website, updated_by FROM sender_profile WHERE id = 1`))[0];
export const senderComplete = (s: SenderProfile) => s.sender_name.trim().length >= 2 && s.mailing_address.trim().length >= 10;
export const getContacts = (cuId?: string) => q<ContactRow>(
  `SELECT c.*, consent_date::text, contact_sendable(c.id) AS sendable FROM contacts c WHERE ($1::text IS NULL OR c.cu_id = $1) ORDER BY c.full_name`, [cuId ?? null]);
export const getLessons = () => q<LessonRow>(`SELECT key, title, summary, body, rule_key, status, sort, updated_by FROM lessons ORDER BY sort, key`);
export const getShares = (cuId?: string) => q<ShareRow>(
  `SELECT s.id, s.video_id, s.contact_id, v.cu_id, cu.name AS cu_name, cu.short_name AS cu_short, c.full_name AS contact_name, c.email AS contact_email, v.format, s.subject, s.body,
          s.lesson_keys, s.status, s.created_at, s.approved_by, s.approved_at, s.sent_at, s.delivery_ref, s.error, s.outcome, s.outcome_note,
          c.unsubscribed_at IS NOT NULL AS unsubscribed
   FROM shares s JOIN videos v ON v.id = s.video_id JOIN contacts c ON c.id = s.contact_id JOIN credit_unions cu ON cu.id = v.cu_id
   WHERE ($1::text IS NULL OR v.cu_id = $1) ORDER BY s.created_at DESC LIMIT 300`, [cuId ?? null]);

/** Per credit union: numbers new, changed or gone between the latest two imports that included it. */
export async function getLatestChanges(): Promise<{ cu_id: string; name: string; changed: number; latest: number; previous: number }[]> {
  return q(`WITH per AS (
      SELECT cu_id, max(import_id) AS latest, (SELECT max(import_id) FROM cu_metric_values w WHERE w.cu_id = v.cu_id AND w.import_id < max(v.import_id)) AS previous
      FROM cu_metric_values v GROUP BY cu_id)
    SELECT p.cu_id, c.name, p.latest::int, p.previous::int,
      ((SELECT count(*) FROM (SELECT year, metric, value FROM cu_metric_values WHERE cu_id = p.cu_id AND import_id = p.latest
                              EXCEPT SELECT year, metric, value FROM cu_metric_values WHERE cu_id = p.cu_id AND import_id = p.previous) a)
     + (SELECT count(*) FROM (SELECT year, metric FROM cu_metric_values WHERE cu_id = p.cu_id AND import_id = p.previous
                              EXCEPT SELECT year, metric FROM cu_metric_values WHERE cu_id = p.cu_id AND import_id = p.latest) b))::int AS changed
    FROM per p JOIN credit_unions c ON c.id = p.cu_id WHERE p.previous IS NOT NULL ORDER BY changed DESC, c.name`);
}
