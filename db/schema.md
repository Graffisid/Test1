# Schema (human-readable)

Postgres 16. Migrations live in `db/migrations/NNN_*.sql`. They are applied in
order by `db/migrate.ts` and recorded in `schema_migrations`.

**Design principle:** if it isn't in the database, it didn't happen. Chat is
the interface; Postgres is the memory.

Every table has `id uuid`, `created_at`, and `updated_at`. A trigger keeps
`updated_at` current.

## The attribution chain

Every link is a foreign key, not a guess:

```
ads ─┬─ ad_variants
     │
     └─ comments ──▶ leads ──▶ calls ──▶ appointments (paid_at / paid_amount_cad)
           ▲            │                     │
        signals ────────┘                customers
```

A lead with `ad_id IS NULL` is reported as **"Unknown source"**. It is never
forced onto an ad.

## Tables

| Table | What a row is | Idempotency key (UNIQUE) |
|---|---|---|
| `ads` | A campaign or ad set on Meta or TikTok, with budget and target CPL | `launch:<ad id>`, set at launch |
| `ad_variants` | One creative (headline, text, CTA, voiceover script, assets) | `publish:<variant id>`, set at publish |
| `signals` | A raw inbound event: comment, DM, form, review, Ad Library poll | `evt:<platform event id>`, **NOT NULL** |
| `customers` | A person who booked a job. `first_ad_id` = the ad that brought them | — (not an outbound action) |
| `comments` | A parsed comment or DM, linked to its signal and ad | `reply:<comment id>`, set when a reply is sent |
| `leads` | One `lead.created` event, plus the CASL consent record | `lead.created:<signal id>`, **NOT NULL** |
| `calls` | One voice-callback attempt (max 2 per lead) | `call:<lead id>:attempt:<n>`, **NOT NULL** |
| `appointments` | A calendar booking and its payment | `booking:<lead id>`, **NOT NULL** |
| `approvals` | One owner decision on a draft, launch, reallocation, or reply | `approval:<kind>:<subject>`, **NOT NULL** |
| `tracked_competitors` | The defined competitor set the poller watches | — (`UNIQUE(page_id)`) |
| `competitor_ads` | One competitor ad, with first/last seen, active flag, rubric breakdown, and verdict | — (`UNIQUE(ad_archive_id)`) |
| `metrics` | Daily platform numbers per variant: spend, impressions, clicks, platform leads | — (`UNIQUE(metric_date, ad_variant_id)`) |
| `agent_activity_log` | Every agent decision and every outbound action | Set for outbound actions |

## Guardrails enforced by the database (not by prompts)

| Rule (MUSE.md) | Where |
|---|---|
| Duplicate outbound actions are impossible | `UNIQUE (idempotency_key)` on every outbound table |
| One lead → one call per attempt, max 2 attempts | `calls`: `UNIQUE(lead_id, direction, attempt)` and `CHECK attempt BETWEEN 1 AND 2` |
| CASL: no outbound call without stored consent | Trigger `calls_consent_check` |
| CASL: consent is complete (who, when, what wording) | `leads_consent_complete` |
| Approval belongs to the human alone | `approvals_human_decider`, `approvals_human_editor` (decider is never an agent name) |
| A decision is always recorded | `approvals_decision_recorded` |
| Angry comments are never auto-replied or auto-hidden | `comments_angry_human_only` |
| Triage below 0.70 confidence goes to a human | `signals_low_confidence_to_human` |
| A live ad or variant went through the idempotent launch/publish path | `ads_live_has_launch`, `ad_variants_live_has_publish` |
| "Paid" only after a completed job | `appointments_paid_needs_completed` |
| Agent names are exactly the eight in `.claude/agents/` | `is_agent_name()` |

| Dashboard can only record decisions, never rewrite data | Role `dashboard_app` (migration 014): `SELECT`, column-level `UPDATE` on approvals and variants, `INSERT` on the log |
| Ingest services can only add raw signals and competitor sightings | Role `ingest_app` (migration 015): `INSERT` on signals, insert and column-level update on competitor_ads, `INSERT` on the log; **no access to leads, approvals, or ads** |
| Signal provenance is never hidden | `signals.ingested_via` ∈ webhook / poller / manual_import / simulator / seed |
| Audit log can't be edited or deleted, by anyone | Trigger `agent_activity_log_no_update_delete`; the `approval_id` foreign key is `ON DELETE RESTRICT` |

Spend caps (weekly $500, per-ad $40/day, $100/day circuit breaker) are
enforced in the launch path in `src/lib/` (Phase 4). The seed test checks
that the mock spend stays under them.

## KPI views

- **`v_daily_kpis`**: one row per Toronto business day, with these columns:
  - `spend_cad` and `impressions`
  - `leads` and `paid_leads`
  - `cost_per_lead_cad`: spend ÷ ad-attributed leads
  - `median_speed_to_lead_s`: lead created → first outbound dial
  - `calls` and `calls_within_60s`
  - `booked`
  - `paid_jobs` and `revenue_cad`
- **`v_ad_attribution`**: one row per ad, plus an **Unknown source** row, with
  these columns:
  - `spend_cad` and `comments`
  - `leads`, `leads_called`, and `booked`
  - `paid_jobs` and `paying_customers`
  - `revenue_cad` and `cost_per_lead_cad`

  Calls and appointments are aggregated per lead before joining, so a lead with
  two call attempts never double-counts revenue. The test checks this view
  against the raw tables.

## Seed data

`npm run db:seed` loads 30 days of mock activity for the fictional
**Northshore Plumbing & Heating** (Burlington, ON):

- **Ads:** 5 ads (4 Meta, 1 parked TikTok draft) and their variants.
- **Ad Library:** 24 competitor ads, scored with the longevity rubric.
- **Engagement:** comments and DMs, plus leads with consent records.
- **Sales:** simulated calls, bookings, and payments.
- **Approvals:** a history of decisions, and today's pending queue.
- **Activity log:** a full log that includes all seven interrupt triggers.

Dates are relative to the moment you run the seed. Re-running it truncates
and reloads.
