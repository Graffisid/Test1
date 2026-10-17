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
| — | Dashboard (KPIs, approvals queue, activity log, digest) on mock data | Next |
| 2–8 | Signals, brain + approvals, paid ads loop, callbacks, attribution, interrupts, hardening | Later |

## Layout

```
MUSE.md                 Operating rules, guardrails, approval law
.env.example            Variable names only — never values
.claude/agents/         The eight agents (role, inputs, outputs, tools, escalation)
.claude/skills/         competitor-scan, ad-cycle, morning-digest, lead-callback
workflows/              Scheduled/triggered jobs (stubs until their phase)
db/migrations/          Numbered SQL migrations
db/schema.md            Human-readable schema
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
npm test                 # Phase 1 gate: fresh-DB migrate + seed, idempotency + guardrail checks
npm run typecheck
```

If `DATABASE_URL` is unset, the scripts default to
`postgres://postgres:postgres@localhost:5432/ai_social_team`. Use that default
for local development only.

The schema, guardrails, and KPI views are documented in
[`db/schema.md`](./db/schema.md).

## Secrets

Copy `.env.example` to `.env` and fill it in locally. Use the host's secret
store in production. Never commit a real key. If one is ever committed,
rotate it.
