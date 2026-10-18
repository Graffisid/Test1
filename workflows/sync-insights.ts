/**
 * sync-insights — records daily ad performance from the ad platform into `metrics`.
 * Mock platform only in this build (simulated spend, deterministic results).
 *
 *   npm run ads:sync-insights            # yesterday
 *   npm run ads:sync-insights -- --days 2
 */
import { MockAdPlatform } from "../src/lib/ad-platform.ts";
import { newClient } from "../src/lib/db.ts";

export function completeDays(n: number, now = new Date()): string[] {
  const today = new Date(`${now.toLocaleDateString("en-CA", { timeZone: "America/Toronto" })}T12:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(today.getTime() - (n - i) * 86_400_000).toISOString().slice(0, 10));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--days");
  const days = completeDays(i > 0 ? Number(process.argv[i + 1]) : 1);
  const db = newClient(process.env.SPEND_DATABASE_URL || undefined);
  await db.connect();
  try {
    const r = await new MockAdPlatform().syncInsights(db, days);
    console.log(`insights (mock) for ${days.join(", ")}: ${r.rowsWritten} rows, simulated spend $${r.simulatedSpendCad.toFixed(2)}`);
  } finally {
    await db.end();
  }
}
