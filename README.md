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
| 3–8 | Brain + approvals, paid ads loop, callbacks, attribution, interrupts, hardening | Later |

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
