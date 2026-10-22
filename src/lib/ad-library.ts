/**
 * Where competitor-ad sightings come from.
 *
 * IMPORTANT (checked 2026-10-17): Meta's Ad Library API only returns political/issue ads, plus
 * commercial ads delivered in the EU/UK. A Burlington plumber's ads are visible on the public
 * Ad Library *website* but not via the API. So this build ships two honest sources:
 *   - MockAdLibrarySource: deterministic fake data for development and tests.
 *   - ManualImportAdLibrarySource: a CSV of what someone saw on the public Ad Library page
 *     (ad id, page id, start date, active?) — labelled as a manual import everywhere.
 * An API-backed or paid third-party source can implement the same interface later (owner decision).
 */
import { readFileSync } from "node:fs";
import { parseCsv } from "./csv.ts";

export interface AdSighting {
  adArchiveId: string;
  pageId: string;
  pageName: string;
  title: string | null;
  body: string | null;
  snapshotUrl: string | null;
  deliveryStart: Date;
  deliveryStop: Date | null; // null = still running when observed
  format?: "video_hook" | "video" | "static" | "no_offer" | null;
}

export interface AdLibrarySource {
  readonly kind: "mock" | "manual_import" | "ad_library_api";
  fetch(pageIds: string[], at: Date): Promise<AdSighting[]>;
}

const DAY = 86_400_000;

/** Fictional competitors for the fictional Northshore Plumbing & Heating. */
export const MOCK_COMPETITORS = [
  { pageId: "mock_page_lakeshore", name: "Lakeshore Comfort Heating" },
  { pageId: "mock_page_haltondrain", name: "Halton Drain Pros" },
  { pageId: "mock_page_escarpment", name: "Escarpment HVAC" },
  { pageId: "mock_page_bayview", name: "Bayview Plumbing Co." },
] as const;

interface MockAd { id: string; page: number; title: string; body: string; startDaysBefore: number; runsDays: number | null; format: AdSighting["format"] }

// startDaysBefore / runsDays are relative to the source's anchor date; null = still running.
const MOCK_ADS: MockAd[] = [
  // Lakeshore: a long-running "first cold night" video concept with 3 variants → learn_from
  { id: "910001", page: 0, title: "First cold night? Is your furnace ready", body: "Book a fall tune-up today.", startDaysBefore: 46, runsDays: null, format: "video_hook" },
  { id: "910002", page: 0, title: "First cold night? Is your furnace ready", body: "Licensed techs across Halton.", startDaysBefore: 39, runsDays: null, format: "video_hook" },
  { id: "910003", page: 0, title: "First cold night? Is your furnace ready", body: "Same-week appointments.", startDaysBefore: 33, runsDays: null, format: "video" },
  { id: "910004", page: 0, title: "Furnace financing available", body: "Ask about monthly payments.", startDaysBefore: 21, runsDays: 5, format: "static" },
  { id: "910005", page: 0, title: "Heat pump rebate explainer", body: "What you need to know this year.", startDaysBefore: 12, runsDays: null, format: "video" },
  { id: "910006", page: 0, title: "Customer testimonial video", body: "Hear from a neighbour in Oakville.", startDaysBefore: 1, runsDays: null, format: null },
  // Halton Drain Pros: emergency + drain camera concepts
  { id: "920001", page: 1, title: "Emergency plumber 24/7", body: "We pick up at 2 a.m.", startDaysBefore: 58, runsDays: null, format: "static" },
  { id: "920002", page: 1, title: "Emergency plumber 24/7", body: "Burst pipe? Call now.", startDaysBefore: 50, runsDays: null, format: "video_hook" },
  { id: "920003", page: 1, title: "Emergency plumber 24/7", body: "Flooded basement help.", startDaysBefore: 44, runsDays: 30, format: "static" },
  { id: "920004", page: 1, title: "Drain camera inspection", body: "See inside your pipes.", startDaysBefore: 18, runsDays: null, format: "video" },
  { id: "920005", page: 1, title: "Drain camera inspection", body: "Before you buy a house.", startDaysBefore: 9, runsDays: 2, format: "static" },
  { id: "920006", page: 1, title: "Spring sump pump check", body: "Don't wait for the thaw.", startDaysBefore: 120, runsDays: 25, format: "static" },
  // Escarpment HVAC
  { id: "930001", page: 2, title: "Fall tune-up special", body: "Book before November.", startDaysBefore: 27, runsDays: null, format: "static" },
  { id: "930002", page: 2, title: "Fall tune-up special", body: "Hamilton Mountain and Ancaster.", startDaysBefore: 20, runsDays: null, format: "no_offer" },
  { id: "930003", page: 2, title: "New furnace in a day", body: "Installed by licensed techs.", startDaysBefore: 15, runsDays: 4, format: "video" },
  { id: "930004", page: 2, title: "Cold climate heat pumps", body: "Heat and cool with one system.", startDaysBefore: 35, runsDays: null, format: "video_hook" },
  { id: "930005", page: 2, title: "Duct cleaning", body: "Breathe easier this winter.", startDaysBefore: 6, runsDays: 3, format: null },
  { id: "930006", page: 2, title: "Hiring licensed HVAC techs", body: "Join our team.", startDaysBefore: 10, runsDays: null, format: "static" },
  // Bayview Plumbing Co.
  { id: "940001", page: 3, title: "Water heater same-day install", body: "Tank or tankless.", startDaysBefore: 41, runsDays: null, format: "video_hook" },
  { id: "940002", page: 3, title: "Water heater same-day install", body: "Cold shower again?", startDaysBefore: 37, runsDays: null, format: "static" },
  { id: "940003", page: 3, title: "Water heater same-day install", body: "Free quote in Burlington.", startDaysBefore: 30, runsDays: null, format: "static" },
  { id: "940004", page: 3, title: "Lowest prices in Halton", body: "Guaranteed.", startDaysBefore: 14, runsDays: 6, format: "no_offer" },
  { id: "940005", page: 3, title: "Toilet repair in an hour", body: "Running toilet? We fix it.", startDaysBefore: 8, runsDays: null, format: "static" },
  { id: "940006", page: 3, title: "Kitchen faucet upgrades", body: "Pick your finish.", startDaysBefore: 3, runsDays: null, format: null },
];

export class MockAdLibrarySource implements AdLibrarySource {
  readonly kind = "mock" as const;
  constructor(private readonly anchor: Date = new Date()) {}

  async fetch(pageIds: string[], at: Date): Promise<AdSighting[]> {
    const wanted = new Set(pageIds);
    const out: AdSighting[] = [];
    for (const ad of MOCK_ADS) {
      const comp = MOCK_COMPETITORS[ad.page];
      if (!wanted.has(comp.pageId)) continue;
      const start = new Date(this.anchor.getTime() - ad.startDaysBefore * DAY);
      if (start > at) continue; // not launched yet at this poll time
      const stop = ad.runsDays === null ? null : new Date(start.getTime() + ad.runsDays * DAY);
      out.push({
        adArchiveId: `mock_${ad.id}`, pageId: comp.pageId, pageName: comp.name, title: ad.title, body: ad.body,
        snapshotUrl: `mock://adlibrary/${ad.id}`, deliveryStart: start,
        deliveryStop: stop && stop <= at ? stop : null, format: ad.format,
      });
    }
    return out;
  }
}

/**
 * CSV columns (header row required):
 *   ad_archive_id, page_id, page_name, title, body, snapshot_url, start_date (YYYY-MM-DD),
 *   stop_date (blank if still running), format (optional: video_hook|video|static|no_offer)
 */
export class ManualImportAdLibrarySource implements AdLibrarySource {
  readonly kind = "manual_import" as const;
  private readonly rows: AdSighting[];

  constructor(csvText: string) {
    this.rows = parseCsv(csvText).map((r, i) => {
      const start = new Date(`${r.start_date}T12:00:00Z`);
      if (!r.ad_archive_id || !r.page_id || Number.isNaN(start.getTime())) {
        throw new Error(`Row ${i + 2}: ad_archive_id, page_id and a valid start_date are required.`);
      }
      const stop = r.stop_date ? new Date(`${r.stop_date}T12:00:00Z`) : null;
      if (stop && Number.isNaN(stop.getTime())) throw new Error(`Row ${i + 2}: invalid stop_date.`);
      const format = (["video_hook", "video", "static", "no_offer"] as const).find((f) => f === r.format) ?? null;
      return { adArchiveId: r.ad_archive_id, pageId: r.page_id, pageName: r.page_name || r.page_id, title: r.title || null,
        body: r.body || null, snapshotUrl: r.snapshot_url || null, deliveryStart: start, deliveryStop: stop, format };
    });
  }

  static fromFile(path: string) {
    return new ManualImportAdLibrarySource(readFileSync(path, "utf8"));
  }

  async fetch(pageIds: string[]): Promise<AdSighting[]> {
    const wanted = new Set(pageIds);
    return this.rows.filter((r) => wanted.has(r.pageId));
  }
}
