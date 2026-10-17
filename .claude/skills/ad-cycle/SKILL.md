---
name: ad-cycle
description: Run the 48-hour paid-ads test-and-reallocate cycle. Collect results, have analyst classify each variant, and propose (never execute) reallocation as a pending approval. Use at the end of each 48h cycle.
---

# ad-cycle: 48-hour test and reallocation

Owners: `analyst` (classification), `growth-director` (dispatch).
Workflow: `workflows/ad-cycle-48h.ts`.

## Steps

1. Collect spend, impressions, leads, and CPL for each live variant over the
   cycle (from `metrics`).
2. `analyst` classifies each variant using the winner/loser JSON schema (see
   `.claude/agents/analyst.md`). Any output that fails the schema is discarded
   and logged.
3. Build a reallocation proposal. Write it as **one** `approvals` row
   (`kind = 'budget_reallocation'`, `idempotency_key = cycle ID`).
4. Stop. Nothing changes until the owner approves.

## Hard rules

- Spend caps (weekly, per-ad, daily circuit breaker) are checked **in code**
  before any budget change. See `src/lib/`.
- One cycle → at most one reallocation.
- Unproven ads get one more cycle, not more budget.
