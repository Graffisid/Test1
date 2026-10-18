# AI Social Media Team

A multi-agent marketing system for a local business. It covers:

- competitor ad research
- ad and content creation
- lead capture from comments and DMs
- a 60-second voice callback to consented leads
- end-to-end attribution (ad → customer)

The owner approves every spend and every publish.

> **Start with [`MUSE.md`](./MUSE.md).** It holds the operating rules,
> guardrails, approval law, and agent roster. Behaviour is configured in
> markdown, not buried in code.

## Status

**Mock mode.** All external integrations (Meta, TikTok, ElevenLabs, Twilio,
Higgsfield, Google Calendar, Telegram/Slack, Anthropic API) are stubbed. There
are no real keys, no ad spend, and no calls.

| Phase | What | State |
|---|---|---|
| 0 | Scaffold, secrets template, operating rules | Done |
| 1 | System of record (Postgres schema + seed + gate test) | Done |
| — | Dashboard (KPIs, approvals queue, activity log, digest) on mock data | Done |
| 2 | Signals ingestion: Meta webhooks, competitor poller, review import | Done (mock), real Meta app pending |
| 3 | Brain (triage, ad-writer, auditor, analyst draft scoring) + approval flow + publish gate | Done (mock model; live Claude off until approved) |
| 4 | Paid ads loop: media, launches, spend caps in the database, 48 h cycle, owner-approved reallocation | Done (simulated spend and media) |
| 5 | Lead capture (approved-template replies, CASL form) + 60-second callback + booking | Done (simulated calls and calendar; consent wording is a draft for review) |
| 6–8 | Attribution + digest reconciliation, interrupts, hardening | Later |

## Layout

```
MUSE.md                 Operating rules, guardrails, approval law
.env.example            Variable names only — never values
.claude/agents/         The eight agents (role, inputs, outputs, tools, escalation)
.claude/skills/         competitor-scan, ad-cycle, morning-digest, lead-callback
workflows/              Scheduled/triggered jobs (stubs until their phase)
db/migrations/          Numbered SQL migrations
db/schema.md            Human-readable schema
dashboard/              Next.js owner dashboard (reads the same Postgres)
src/api/                Webhook receivers, approval endpoints
src/lib/                Idempotency, spend-cap, logging helpers
tests/                  One test per phase gate
```

## Run it locally

Requirements: Node 20 or newer, and Postgres 16 on `localhost:5432`.

```bash
npm install
cp .env.example .env     # optional: set DATABASE_URL
npm run db:reset         # drop, migrate from empty, seed mock data
npm test                 # Phase 1 gate + security tests (least privilege, append-only log, sessions)
npm run typecheck
```

If `DATABASE_URL` is unset, the scripts default to
`postgres://postgres:postgres@localhost:5432/ai_social_team`. Use that default
for local development only.

The schema, guardrails, and KPI views are documented in
[`db/schema.md`](./db/schema.md).

### Sandbox: click through the whole platform

```bash
npm install && (cd dashboard && npm install)
npm run sandbox            # or: npm run sandbox -- --keep  (keeps current data)
```

This command:

- Resets the **local** database to fresh seed data. It refuses to run against
  any other host.
- Creates every least-privilege login with a new random password.
- Starts three services:
  - The webhook receiver and capture form, on port 3001.
  - The voice dispatcher.
  - The dashboard, at <http://127.0.0.1:3000>.
- Prints a one-time owner password.

The passwords and service URLs are written to `.sandbox/`. That folder is
gitignored and readable only by you. `dashboard/.env.local` is never touched.
Everything external stays simulated. Ctrl-C stops it all.

To act as the outside world and the agents, open a second terminal:

```bash
set -a; . .sandbox/sandbox.env; set +a
npm run simulate:meta && npm run brain:triage
npm run leads:qualify        # prints capture links: open one, fill the form, watch the call get booked
npm run brain:write-ads -- "Furnace Tune-Up"     # then Approve a draft in the dashboard
npm run media:produce && npm run publish:approved
npm run spend:execute        # after approving a budget change
```

## Signals ingestion (Phase 2)

```bash
# once: least-privilege DB login for the receiver, poller and imports
DB_LOGIN_PASSWORD="$(openssl rand -hex 24)" npm run db:create-login -- ingest
# then set INGEST_DATABASE_URL, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN (see .env.example)

npm run ingest:start                       # webhook receiver on http://127.0.0.1:3001
npm run simulate:meta -- --repeat          # signed test deliveries (comments, DMs, lead form, rating)
npm run poll:competitors                   # competitor ads (mock source)
npm run poll:competitors -- --csv ads.csv  # manual import from the public Ad Library website
npm run reviews:import -- reviews.csv      # manual review import
```

- **Webhook receiver** (`src/api/`): the receiver checks each delivery in a
  fixed order:
  1. **Size:** anything over 1 MB is refused.
  2. **Signature:** the `X-Hub-Signature-256` HMAC is checked against the raw
     bytes.
  3. **JSON:** the body is parsed.
  4. **Store:** each event becomes a `signals` row, keyed on Meta's event id,
     so retries are no-ops.

  What it handles:
  - Page comments, lead forms, and ratings.
  - Instagram comments and mentions.
  - Messenger and Instagram DMs.

  Our own echoes and edits are ignored. Anything the public writes is stored
  as `payload.untrusted_text`.
- **Competitor poller** (`workflows/poll-competitors.ts`): records first-seen
  and last-seen for every ad from the tracked competitors. It scores each ad
  with the Section 8 rubric and stores the full breakdown. The first sighting
  of an ad raises one `ad_library` signal.

  **The Ad Library API can't see Canadian commercial ads**, so the only real
  source today is a manual CSV import. See the `MUSE.md` provider log.
- **Provenance:** every signal records `ingested_via`: `webhook`, `poller`,
  `manual_import`, `simulator`, or `seed`.

## The brain and the approval flow (Phase 3)

```bash
# once: least-privilege logins for the agents and the publisher
DB_LOGIN_PASSWORD="$(openssl rand -hex 24)" npm run db:create-login -- brain       # → BRAIN_DATABASE_URL
DB_LOGIN_PASSWORD="$(openssl rand -hex 24)" npm run db:create-login -- publisher   # → PUBLISHER_DATABASE_URL

npm run brain:triage                          # classify + route every new signal
npm run brain:write-ads -- "Furnace Tune-Up"  # 20 drafts → auditor → analyst → top 3 to your queue
# approve / edit / reject in the dashboard
npm run publish:approved                      # the ONLY publish path (simulated: nothing reaches Meta)
```

- **triage** classifies each signal: intent, confidence, language, urgency,
  and where it goes (`route_to`).
  - **Validation:** the output must pass a Zod schema. Anything invalid is
    discarded, logged, and routed to a human.
  - **Routing rules:** code overrides the model. Anything angry, or below 0.70
    confidence, goes to a human, and a database constraint enforces this too.
  - **Untrusted text:** public text reaches the model inside
    `<untrusted_customer_text>` as data. A message that tries to give
    instructions is routed to a human.
- **ad-writer** writes 20 variants per cycle. It learns from your scored
  winners and from competitor concepts in the learn-from tier.
  - **Auditor** (code): rejects banned claims and flags unverifiable ones,
    using the rules in `MUSE.md`.
  - **Analyst** (code): scores every surviving draft with a transparent rubric.
    The top 3 become `draft` variants, each with a `pending` approval.
  - **Once per cycle:** each ad gets one run per cycle.
  - **No status changes:** ad-writer can't set any status. Its column-level
    database grants won't allow it.
- **Publish gate:** every publish is a `publications` row. The database refuses
  one unless a human approved that approval, before it expired. One approval
  allows at most one publication.

  A variant can't be `live` without a publication, and this is checked at
  commit, even for the superuser. Rejecting a draft therefore makes every
  publish path fail.
- **Model:**
  - **Default:** a deterministic mock, so nothing is paid.
  - **Live Claude:** set `LLM_MODE=live`, with `MOCK_MODE` not equal to `mock`.
    This uses `claude-opus-5-5` via the official SDK's structured outputs
    (`messages.parse`), at `low` effort for triage and `medium` for ad-writer.
  - **Daily cap:** live calls are capped per day by `LLM_DAILY_BUDGET_CAD`,
    checked in code against the activity log.

## Paid ads loop (Phase 4)

```bash
DB_LOGIN_PASSWORD="$(openssl rand -hex 24)" npm run db:create-login -- media   # → MEDIA_DATABASE_URL
DB_LOGIN_PASSWORD="$(openssl rand -hex 24)" npm run db:create-login -- spend   # → SPEND_DATABASE_URL

npm run spend:execute            # launches + budget changes the OWNER approved (simulated spend)
npm run media:produce            # video + voiceover for approved variants (simulated, no credits)
npm run publish:approved         # publishes approved variants once their media is ready
npm run ads:sync-insights -- --days 2   # simulated daily results → metrics
npm run ads:cycle                # analyst: classify, file the cycle report, PROPOSE a reallocation
```

- **Spend caps** are in the database: table `spend_caps`, with a trigger on
  every launch and every budget increase, for every role including the
  superuser.
  - **Per-ad daily cap:** $40.
  - **Daily circuit breaker:** $100 across all live ads.
  - **Weekly cap:** this week's actual spend plus the remaining days at
    current budgets must stay at or under $500.
  - **Freeze:** a spend freeze blocks every increase.

  Decreases and pauses are never blocked.
- **Executor:** launches and budget changes happen only through database
  functions (`launch_ad`, `apply_budget_change`, `kill_variant`). Each one
  re-verifies a human-approved approval.
  - The spend role has **no** direct UPDATE on ads.
  - One approval gives at most one change per ad.
  - A refused change is logged as a `budget_limit_reached` block.
- **48 h cycle** (`workflows/ad-cycle-48h.ts`):
  - **Classify:** each live variant is classified with the Section 8 rules.
  - **Report:** the cycle files a report naming the winner with its data.
  - **Propose:** it proposes, never executes, a +20% budget for ads with a
    winner (inside the caps), kills losers, and pauses all-loser ads. Missing
    data means "hold".
- **media-producer** generates only after the copy is approved, using a
  different voice per variant. It stops and escalates before a batch would
  cost over `MEDIA_BATCH_THRESHOLD_CAD`, or after 2 failures in a row.

## Lead capture and the 60-second callback (Phase 5)

```bash
DB_LOGIN_PASSWORD="$(openssl rand -hex 24)" npm run db:create-login -- qualifier   # → QUALIFIER_DATABASE_URL
DB_LOGIN_PASSWORD="$(openssl rand -hex 24)" npm run db:create-login -- voice       # → VOICE_DATABASE_URL
# + CAPTURE_LINK_SECRET and PUBLIC_BASE_URL (see .env.example)

npm run ingest:start          # also serves the capture form (/c/<token>) and opt-out (/u/<token>)
npm run voice:dispatcher      # worker: wakes on every new consented lead (Postgres NOTIFY), polls as fallback
npm run leads:qualify         # approved-template replies with capture links; leads from Meta lead forms
```

- **lead-qualifier** replies only with an owner-approved template from
  `MUSE.md`, word for word, plus a personal signed link.
  - The link expires after 7 days and carries attribution to the comment and
    the ad.
  - Each comment gets one reply, and angry comments get none.
  - A Meta lead form counts as consent only if it showed our exact wording.
- **Capture form:**
  - **Consent box:** never pre-ticked. It shows the exact CASL wording from
    `MUSE.md` and the sender's identification. The wording, version, and time
    are stored with every lead.
  - **One lead per link.**
  - **Protections:** server-side validation, a honeypot field, per-IP rate
    limiting, and a strict CSP with no scripts.
- **voice-dispatcher:** the call row is written **before** dialling, so a
  crash or a duplicate wake-up can never call twice.
  - **Attempts:** at most 2, 10 minutes apart. After two failures, the lead
    goes to a human.
  - **Big deals:** estimated value ≥ $5,000 goes straight to the owner and the
    sales lead, with no AI call.
  - **Bookings:** go to Mon–Sat business hours.
- **CASL in the database:** a call is refused unless consent is stored and not
  withdrawn, and the number isn't on the do-not-contact list. This holds for
  every role.

  Every confirmation page has an opt-out link, which withdraws consent for that
  number and suppresses it.

## Dashboard

```bash
# once: least-privilege DB login for the dashboard (never the superuser)
DASHBOARD_DB_PASSWORD="$(openssl rand -hex 24)" npm run db:create-dashboard-login

cd dashboard
npm install
cp .env.example .env.local   # fill in DATABASE_URL, DASHBOARD_PASSWORD, SESSION_SECRET
npm run build && npm start   # http://127.0.0.1:3000 — owner sign-in required
npm run security-check       # (in another terminal) 20 HTTP-level security checks
```

Security model, threat table and remaining risks: [`SECURITY.md`](./SECURITY.md).

- **Overview (`/`):** the four KPI cards, the approvals queue, and a live
  agent activity feed.
  - **KPI cards:** Cost Per Lead, Speed to Lead, Booked & Paid, and Ad to
    Customer.
  - **Approvals queue:** each item has Approve / Edit / Reject buttons.
  - **Activity feed:** refreshes every 5 seconds. You can filter by agent or
    show only interrupts and escalations.
- **Morning digest (`/digest`):** the one-page summary from
  `.claude/skills/morning-digest/` for any past day.

**Approve** writes an `approvals` row decided by the owner, plus activity-log
rows. It does **not** publish or spend, because no publish or spend path
exists yet.

- **Edit** keeps the item pending.
- **Reject** takes an optional note.
- **Unverified claims:** a draft flagged for one can't be approved until you
  confirm the claim. The server enforces this as well as the browser.
- **Expired items:** pending items past their deadline are marked expired,
  never approved.

`npm run db:seed` (from the repo root) restores the demo queue.

## Secrets

Copy `.env.example` to `.env` and fill it in locally. Use the host's secret
store in production. Never commit a real key. If one is ever committed,
rotate it.
