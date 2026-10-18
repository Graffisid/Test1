/**
 * The 60-second callback's moving parts: the voice agent (ElevenLabs conversational agent over
 * Twilio in reality) and the calendar (Google Calendar in reality). Both are SIMULATED here — no call
 * is placed and no real calendar is touched. Real adapters must keep these contracts.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";

export type CallOutcome = "booked" | "follow_up" | "no_answer" | "voicemail" | "asked_for_human" | "not_interested";

export interface CallResult {
  outcome: CallOutcome;
  answeredAfterS: number | null;
  durationS: number;
  summary: string;
  estCostCad: number;
}

export interface VoiceAgent {
  readonly name: string;
  call(lead: { id: string; name: string; phone_e164: string; service_label: string }): Promise<CallResult>;
}

/**
 * Deterministic test numbers (fictional 555-01xx range):
 *   …0199 no answer · …0198 asks for a person · …0197 not interested · …0196 wants a follow-up
 *   anything else books.
 */
export class MockVoiceAgent implements VoiceAgent {
  readonly name = "mock_elevenlabs_twilio";
  async call(lead: { name: string; phone_e164: string; service_label: string }): Promise<CallResult> {
    const tail = lead.phone_e164.slice(-4);
    const outcome: CallOutcome = tail === "0199" ? "no_answer" : tail === "0198" ? "asked_for_human"
      : tail === "0197" ? "not_interested" : tail === "0196" ? "follow_up" : "booked";
    const answered = outcome === "no_answer" ? null : 6;
    const duration = outcome === "no_answer" ? 0 : outcome === "booked" ? 140 : 75;
    const summary = {
      booked: `${lead.name} needs ${lead.service_label.toLowerCase()}. Confirmed address and booked the first open slot.`,
      follow_up: "Interested; wants to check with their partner. Agreed to a follow-up.",
      no_answer: "No answer.",
      voicemail: "Left a voicemail with our number.",
      asked_for_human: "Caller asked to speak with a person — handed off.",
      not_interested: "Not booking right now. Thanked them; no further calls.",
    }[outcome];
    return { outcome, answeredAfterS: answered, durationS: duration, summary,
      estCostCad: Math.round((duration / 60) * 0.15 * 100) / 100 };
  }
}

export interface Calendar {
  readonly name: string;
  nextSlot(db: pg.ClientBase, after: Date): Promise<Date>;
  /** The next n open visit times (held and confirmed visits count as taken). */
  freeSlots(db: pg.ClientBase, after: Date, n: number): Promise<Date[]>;
  book(slot: Date, title: string): Promise<string>;
}

const TZ = "America/Toronto";
function tzOffsetMs(instant: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(instant / 1000) * 1000;
}
function torontoSlot(dateStr: string, hour: number): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  return new Date(guess - tzOffsetMs(guess));
}

/** Business hours: Mon–Sat, 2-hour visits starting 8:00, 10:00, 12:00, 14:00 (Toronto), ≥ 2 h from now. */
export class MockCalendar implements Calendar {
  readonly name = "mock_google_calendar";
  async nextSlot(db: pg.ClientBase, after: Date): Promise<Date> {
    const [slot] = await this.freeSlots(db, after, 1);
    return slot;
  }
  async freeSlots(db: pg.ClientBase, after: Date, n: number): Promise<Date[]> {
    const earliest = after.getTime() + 2 * 3600_000;
    const out: Date[] = [];
    for (let day = 0; day < 21 && out.length < n; day++) {
      const date = new Date(after.getTime() + day * 86400_000).toLocaleDateString("en-CA", { timeZone: TZ });
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      if (weekday === 0) continue; // closed Sundays (emergencies go through the 24/7 line)
      for (const hour of [8, 10, 12, 14]) {
        const slot = torontoSlot(date, hour);
        if (slot.getTime() < earliest) continue;
        const { rowCount } = await db.query(
          `SELECT 1 FROM appointments WHERE status IN ('scheduled', 'pending_owner') AND scheduled_for = $1`, [slot]);
        if (!rowCount) out.push(slot);
        if (out.length === n) break;
      }
    }
    if (out.length < n) throw new Error("No free slot in the next 3 weeks");
    return out;
  }
  async book(): Promise<string> {
    return `mock_gcal_${randomUUID().slice(0, 12)}`;
  }
}
