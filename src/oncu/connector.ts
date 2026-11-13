/**
 * ONCU Insights connector (read-only). Reads ONCU's data layer — `registry.json` plus one
 * `credit-unions/<slug>.json` per credit union — from a local checkout of the ONCU repository,
 * and records it as one import.
 *
 * - Nothing is ever written back to ONCU.
 * - Each import stores every value it read, so past imports stay readable (history), and the latest
 *   import is "now". Unchanged data (same content hash) is not imported twice.
 * - Only numbers ONCU classifies as audited, official or calculated from those are kept as metrics.
 *   Reported observations without verified values are skipped.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type pg from "pg";
import { z } from "zod";

/** ONCU metric classifications a story may rely on. */
export const STORY_CLASSIFICATIONS = new Set([
  "Audited data", "Calculated data", "Calculated from audited data", "Calculated when inputs are present",
  "Official public source", "Annual report highlight",
]);

/** Base (non-calculated) classifications. Calculated ratios count only when the base figures are one of these. */
const BASE_CLASSIFICATIONS = new Set(["Audited data", "Official public source", "Annual report highlight"]);

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const slug = z.string().regex(/^[a-z0-9-]{2,40}$/);
const text = (max: number) => z.string().max(max);
const optText = (max: number) => z.union([z.string().max(max), z.number()]).nullish().transform((v) => (v == null || v === "" ? null : String(v)));
const httpsUrl = z.string().max(2000).nullish().transform((v) => (v && /^https?:\/\//.test(v) ? v : null));

const Registry = z.object({
  rosterVerified: z.string().nullish(),
  institutions: z.array(z.object({
    id: slug, name: text(200), short: text(80).nullish(), city: text(120).nullish(),
    primary: z.string().nullish(), website: z.string().nullish(), legalName: text(300).nullish(), dataset: z.string().nullish(),
  }).passthrough()).max(500),
}).passthrough();

const CuFile = z.object({
  dataset: z.object({
    profile: z.object({
      id: slug, name: text(200), short: text(80).nullish(), legalName: text(300).nullish(), website: z.string().nullish(),
      headOffice: text(300).nullish(), currentCEO: text(200).nullish(), chair: text(200).nullish(),
      branches: z.number().int().nullish(), members: z.number().int().nullish(), reportingYear: z.number().int().nullish(),
      asOf: text(80).nullish(), dataTier: text(60).nullish(), caveat: text(8000).nullish(),
    }).passthrough(),
    executiveInsight: z.object({ title: text(300).nullish(), summary: text(2000).nullish() }).passthrough().nullish(),
    metricCatalog: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9]{1,40}$/), classification: text(200), sources: z.array(z.string().max(40)).nullish() }).passthrough()).nullish(),
    sources: z.array(z.object({
      id: z.string().max(40), label: text(500), url: z.string().max(2000).nullish(), kind: optText(300), year: optText(300),
      confidence: optText(500), reviewedAt: optText(200),
    }).passthrough()).nullish(),
    queries: z.object({ financials: z.object({ rows: z.array(z.record(z.string(), z.unknown())).max(50) }).passthrough().nullish() }).passthrough().nullish(),
  }).passthrough(),
  seeds: z.array(z.object({
    id: z.string().max(200), category: optText(200), subcategory: optText(200), metricOrFinding: text(2000),
    value: optText(8000), unit: optText(100), period: optText(200), sourceURL: z.string().max(2000).nullish(),
    sourceDocument: optText(1000), collectionDate: optText(40), dataType: optText(100), confidence: optText(200),
    verificationStatus: optText(500), approvalStatus: optText(100),
  }).passthrough()).max(5000),
}).passthrough();

export interface ParsedCu {
  id: string; name: string; short: string; legalName: string | null; city: string | null; website: string | null;
  headOffice: string | null; ceo: string | null; chair: string | null; branches: number | null; members: number | null;
  reportingYear: number | null; asOf: string | null; dataTier: string | null; caveat: string | null; brandPrimary: string | null;
  executiveTitle: string | null; executiveSummary: string | null;
  metrics: { year: number; metric: string; value: number; classification: string; sourceIds: string[] }[];
  sources: { key: string; label: string; url: string | null; kind: string | null; year: string | null; confidence: string | null; reviewedAt: string | null }[];
  facts: { id: string; category: string | null; subcategory: string | null; finding: string; value: string | null; unit: string | null;
    period: string | null; sourceUrl: string | null; sourceDocument: string | null; collectionDate: string | null; dataType: string | null;
    confidence: string | null; verification: string | null; approval: string | null }[];
}

export interface Snapshot { dir: string; hash: string; commit: string | null; rosterVerified: string | null; cus: ParsedCu[] }

function readJson(path: string): unknown {
  if (statSync(path).size > MAX_FILE_BYTES) throw new Error(`${path} is larger than ${MAX_FILE_BYTES} bytes`);
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Reads and validates an ONCU data directory (the folder holding registry.json and credit-unions/). */
export function readSnapshot(dataDir: string): Snapshot {
  const dir = resolve(dataDir);
  const cuDir = join(dir, "credit-unions");
  const files = readdirSync(cuDir).filter((f) => /^[a-z0-9-]{2,40}\.json$/.test(f)).sort();
  if (!files.length) throw new Error(`No credit union files in ${cuDir}`);

  const hash = createHash("sha256");
  const registryRaw = readFileSync(join(dir, "registry.json"));
  hash.update("registry.json\0").update(registryRaw).update("\0");
  const registry = Registry.parse(JSON.parse(registryRaw.toString("utf8")));
  const byId = new Map(registry.institutions.map((i) => [i.id, i]));

  const cus: ParsedCu[] = [];
  for (const f of files) {
    const path = join(cuDir, f);
    hash.update(f + "\0").update(readFileSync(path)).update("\0");
    const parsed = CuFile.safeParse(readJson(path));
    if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    const { dataset: ds, seeds } = parsed.data;
    const p = ds.profile;
    if (`${p.id}.json` !== f) throw new Error(`${f}: profile id "${p.id}" does not match the file name`);
    const reg = byId.get(p.id);
    const catalog = new Map((ds.metricCatalog ?? []).map((m) => [m.id, m]));
    const metrics: ParsedCu["metrics"] = [];
    // A ratio is only as good as its inputs: if ONCU's own base figures (assets) are unverified, its ratios are left out too.
    const baseOk = BASE_CLASSIFICATIONS.has(catalog.get("assets")?.classification ?? "");
    for (const row of ds.queries?.financials?.rows ?? []) {
      const year = Number(row.year);
      if (!Number.isInteger(year)) continue;
      for (const [metric, m] of catalog) {
        const v = row[metric];
        if (typeof v !== "number" || !Number.isFinite(v) || !STORY_CLASSIFICATIONS.has(m.classification)) continue;
        if (m.classification.startsWith("Calculated") && !baseOk) continue;
        metrics.push({ year, metric, value: v, classification: m.classification, sourceIds: (m.sources ?? []).slice(0, 20) });
      }
    }
    cus.push({
      id: p.id, name: p.name, short: p.short ?? reg?.short ?? p.name, legalName: p.legalName ?? reg?.legalName ?? null,
      city: reg?.city ?? null, website: [p.website, reg?.website].find((w) => w && /^https:\/\//.test(w)) ?? null,
      headOffice: p.headOffice ?? null, ceo: p.currentCEO ?? null, chair: p.chair ?? null, branches: p.branches ?? null,
      members: p.members ?? null, reportingYear: p.reportingYear ?? null, asOf: p.asOf ?? null, dataTier: p.dataTier ?? null,
      caveat: p.caveat ?? null, brandPrimary: reg?.primary && /^#[0-9a-fA-F]{6}$/.test(reg.primary) ? reg.primary : null,
      executiveTitle: ds.executiveInsight?.title ?? null, executiveSummary: ds.executiveInsight?.summary ?? null,
      metrics,
      sources: (ds.sources ?? []).map((s) => ({ key: s.id, label: s.label, url: s.url && /^https?:\/\//.test(s.url) ? s.url : null,
        kind: s.kind, year: s.year, confidence: s.confidence, reviewedAt: s.reviewedAt })),
      facts: seeds.map((s) => ({ id: s.id, category: s.category, subcategory: s.subcategory, finding: s.metricOrFinding, value: s.value,
        unit: s.unit, period: s.period, sourceUrl: httpsUrl.parse(s.sourceURL), sourceDocument: s.sourceDocument,
        collectionDate: s.collectionDate, dataType: s.dataType, confidence: s.confidence, verification: s.verificationStatus,
        approval: s.approvalStatus })),
    });
  }
  let commit: string | null = null;
  try {
    commit = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!/^[0-9a-f]{7,40}$/.test(commit)) commit = null;
  } catch { /* not a git checkout */ }
  return { dir, hash: hash.digest("hex"), commit, rosterVerified: registry.rosterVerified ?? null, cus };
}

export interface ImportResult { importId: number; created: boolean; cus: number; metrics: number; facts: number }

async function insertMany(client: pg.ClientBase, table: string, cols: string[], rows: unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const params: unknown[] = [];
    const values = chunk.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(",")})`).join(",");
    await client.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values}`, params);
  }
}

/** Records a snapshot as one import, in one transaction. Same content as an earlier import → nothing new. */
export async function importSnapshot(client: pg.ClientBase, snap: Snapshot): Promise<ImportResult> {
  const existing = await client.query<{ id: string }>("SELECT id FROM oncu_imports WHERE content_hash = $1", [snap.hash]);
  const metricCount = snap.cus.reduce((n, c) => n + c.metrics.length, 0);
  const factCount = snap.cus.reduce((n, c) => n + c.facts.length, 0);
  if (existing.rowCount) return { importId: Number(existing.rows[0].id), created: false, cus: snap.cus.length, metrics: metricCount, facts: factCount };

  await client.query("BEGIN");
  try {
    const { rows: [imp] } = await client.query<{ id: string }>(
      `INSERT INTO oncu_imports (source, source_commit, content_hash, roster_verified, cu_count, metric_count, fact_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [snap.dir.slice(-300), snap.commit, snap.hash, /^\d{4}-\d{2}-\d{2}$/.test(snap.rosterVerified ?? "") ? snap.rosterVerified : null,
        snap.cus.length, metricCount, factCount]);
    const id = Number(imp.id);
    for (const c of snap.cus) {
      await client.query(
        `INSERT INTO credit_unions (id, name, short_name, legal_name, city, website, head_office, ceo, chair, branches, members,
           reporting_year, as_of, data_tier, caveat, brand_primary, executive_title, executive_summary, first_import_id, last_import_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name, legal_name = EXCLUDED.legal_name,
           city = EXCLUDED.city, website = EXCLUDED.website, head_office = EXCLUDED.head_office, ceo = EXCLUDED.ceo, chair = EXCLUDED.chair,
           branches = EXCLUDED.branches, members = EXCLUDED.members, reporting_year = EXCLUDED.reporting_year, as_of = EXCLUDED.as_of,
           data_tier = EXCLUDED.data_tier, caveat = EXCLUDED.caveat, brand_primary = EXCLUDED.brand_primary,
           executive_title = EXCLUDED.executive_title, executive_summary = EXCLUDED.executive_summary, last_import_id = EXCLUDED.last_import_id`,
        [c.id, c.name, c.short, c.legalName, c.city, c.website, c.headOffice, c.ceo, c.chair, c.branches, c.members, c.reportingYear,
          c.asOf, c.dataTier, c.caveat, c.brandPrimary, c.executiveTitle, c.executiveSummary, id]);
      await insertMany(client, "cu_metric_values", ["import_id", "cu_id", "year", "metric", "value", "classification", "source_ids"],
        c.metrics.map((m) => [id, c.id, m.year, m.metric, m.value, m.classification, m.sourceIds]));
      const seen = new Set<string>();
      await insertMany(client, "cu_sources", ["import_id", "cu_id", "source_key", "label", "url", "kind", "year", "confidence", "reviewed_at"],
        c.sources.filter((s) => !seen.has(s.key) && seen.add(s.key))
          .map((s) => [id, c.id, s.key, s.label, s.url, s.kind, s.year, s.confidence, s.reviewedAt]));
      const seenFacts = new Set<string>();
      await insertMany(client, "cu_facts", ["import_id", "cu_id", "fact_id", "category", "subcategory", "finding", "value", "unit", "period",
        "source_url", "source_document", "collection_date", "data_type", "confidence", "verification_status", "oncu_approval"],
        c.facts.filter((f) => !seenFacts.has(f.id) && seenFacts.add(f.id))
          .map((f) => [id, c.id, f.id, f.category, f.subcategory, f.finding, f.value, f.unit, f.period, f.sourceUrl, f.sourceDocument,
            f.collectionDate, f.dataType, f.confidence, f.verification, f.approval]));
    }
    await client.query("COMMIT");
    return { importId: id, created: true, cus: snap.cus.length, metrics: metricCount, facts: factCount };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
