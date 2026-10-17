---
name: competitor-scan
description: Score competitor ads from Meta Ad Library polling data using the longevity rubric (build plan Section 8). Use when ranking competitor ads to decide which ones ad-writer should learn from.
---

# competitor-scan: Ad Library longevity scoring

Owner: `analyst`. Data source: `workflows/poll-competitors.ts`, which runs
every 6 hours (stubbed in mock mode).

## Rubric

Record the full score breakdown for each ad, never just the total.

| Signal | How to measure | Score |
|---|---|---|
| Longevity | Days between first-seen and last-seen | 0–2 d: 0 · 3–13 d: 1 · 14–29 d: 3 · 30+ d: 5 |
| Persistence | Still active at the latest poll? | Active: +2 · Stopped within 7 d of first sighting: −2 |
| Variant count | Near-duplicate variants of the same concept | 3+ variants: +2 |
| Format | Video with a clear hook in the first 3 s | +1 · No clear offer/CTA: −1 |

## Thresholds

- **Total ≥ 7:** learn from it (feed to `ad-writer`).
- **4–6:** watchlist.
- **≤ 3:** ignore.

## Caveat

Longevity is a heuristic, not proof. Ads also run long because of big budgets,
slow review cycles, or inattention. The 48-hour test on our own budget is what
actually validates an idea.
