/**
 * Text-message building blocks for the phone assistant: filling an approved template (and proving the
 * result is that template), reading a customer's reply, and writing times the way people read them.
 * No model is involved: replies are understood with plain rules, and anything unclear goes to the owner.
 */
import { priceList, textTemplates, type PriceListEntry } from "../brain/muse.ts";

const TZ = "America/Toronto";

export function fillTemplate(key: string, values: Record<string, string>): string {
  const t = textTemplates().find((x) => x.key === key);
  if (!t) throw new Error(`No approved text template "${key}" in MUSE.md`);
  const text = t.text.replace(/\{(\w+)\}/g, (_, k: string) => {
    if (!(k in values)) throw new Error(`Template ${key} needs {${k}}`);
    return values[k];
  });
  // Belt and braces: the result must be the approved wording with only the placeholders filled in.
  const keys: string[] = [];
  const pattern = t.text.split(/(\{\w+\})/).map((part) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (m) { keys.push(m[1]); return "([\\s\\S]+?)"; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  const got = new RegExp(`^${pattern}$`).exec(text);
  if (!got || keys.some((k, i) => got[i + 1] !== values[k])) throw new Error(`Text for ${key} does not match the approved template`);
  return text;
}

export function quoteFor(service: string): PriceListEntry | null {
  return priceList().find((p) => p.service === service) ?? null;
}

export function quoteTemplateKey(basis: PriceListEntry["basis"]): string {
  return basis === "fixed" ? "quote-fixed-v1" : basis === "service_call" ? "quote-call-v1" : "quote-visit-v1";
}

export type Reply = { kind: "yes" } | { kind: "no" } | { kind: "stop" } | { kind: "pick"; choice: 1 | 2 | 3 } | { kind: "unclear" };

/** Plain rules, deliberately narrow: if it's not clearly one of these, a person reads it. */
export function readReply(body: string): Reply {
  const t = body.trim().toLowerCase().replace(/[.!]+$/g, "");
  if (/^(stop|stopall|unsubscribe|cancel|end|quit)$/.test(t)) return { kind: "stop" };
  if (/^(yes|y|yeah|yep|yes please|sure|ok|okay|book it|sounds good)$/.test(t)) return { kind: "yes" };
  if (/^(no|n|nope|no thanks|not now|no thank you)$/.test(t)) return { kind: "no" };
  const m = /^(?:option\s*)?#?([123])$/.exec(t);
  if (m) return { kind: "pick", choice: Number(m[1]) as 1 | 2 | 3 };
  return { kind: "unclear" };
}

export function slotLabel(d: Date): string {
  return d.toLocaleString("en-CA", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .replace(/\./g, "").replace(/,(?=[^,]*$)/, " at");
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
