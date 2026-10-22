import { Icon } from "@/components/Icon";
import { change } from "./fmt";

/** "▲ 12% vs last week" — colour says good/bad, the arrow and words say which way (never colour alone). */
export function Delta({ cur, prev, goodWhen = "up", vs = "vs last week" }: { cur: number; prev: number; goodWhen?: "up" | "down" | "neither"; vs?: string }) {
  const c = change(cur, prev);
  const tone = c.dir === "flat" || goodWhen === "neither" ? "flat" : (c.dir === goodWhen ? "good" : "bad");
  const text = c.pct === null ? (cur > 0 ? "new" : "no change") : `${Math.abs(c.pct * 100) >= 10 ? Math.round(Math.abs(c.pct * 100)) : Math.abs(c.pct * 100).toFixed(1)}%`;
  return (
    <span className={`delta delta-${tone}`}>
      {c.dir !== "flat" && <Icon name={c.dir === "up" ? "arrowUp" : "arrowDown"} />}
      <strong>{c.dir === "flat" ? "No change" : text}</strong>
      <span className="delta-vs">{vs}</span>
    </span>
  );
}
