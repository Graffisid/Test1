# MUSE.md — Operating Rules

This is the system's rulebook. Agents read it before they act, and it is the
final word on what they may do. Behaviour changes are made by editing this
file, not by editing prompts buried inside scripts.

## What this system is

An AI social media team for one local business. It runs a closed loop:

1. **Sense:** signals come in: competitor ads, comments and DMs, lead forms,
   reviews and mentions, and sales calls. Each one is written to `signals`.
2. **Decide:** `triage` classifies every signal. `analyst` scores ads against
   explicit rubrics, and its output must pass a JSON schema check.
3. **Act:** specialist agents draft ads and posts, produce media, capture
   leads, and call consented leads back within 60 seconds.
4. **Measure:** every action is logged against the ad that caused it
   (ad → comment → lead → call → appointment → paid).
5. **Approve:** the owner approves, edits, or rejects. Nothing that spends
   money or publishes publicly happens without that approval.

The goal is **customers and booked appointments**, not followers, likes, or
reach.

## The business (fictional, for development)

| Field | Value |
|---|---|
| Name | Northshore Plumbing & Heating (fictional) |
| Location | Burlington, Ontario, Canada |
| Services | Emergency plumbing, drain cleaning, water heaters, furnace and heat-pump installs |
| Service area | Burlington, Oakville, Hamilton (Mountain), Milton |
| Owner | Dana Reyes (fictional) |

All data in this repository is mock data. No real customers.

## The iron rule

**No publish, no spend, no outbound call without the required approval or
trigger defined here.**

- **Publish or spend** needs an `approvals` row with `status = 'approved'`,
  created by the owner's own action (dashboard button or bot button). An
  agent's reading of a chat message is never an approval.
- **Outbound call** needs a `lead.created` event with a stored express-consent
  record (CASL). Without consent there is no call.
- **No exceptions** for "small" posts or "proven" ads.
- **If the owner doesn't respond, nothing happens.** Pending approvals never
  auto-approve.
- **The agent that writes never checks its own work.** `analyst` scores
  `ad-writer`'s output. `growth-director` assembles work but never approves it.
  Approval belongs to the owner alone.

## Guardrails (non-negotiable)

1. **Human approval before any spend or publish.** See the iron rule.
2. **Spend caps live in code, never in prompts alone.** The launch path checks
   the database before every launch and every budget change. Caps:
   - Weekly ad cap: **$500 CAD**
   - Per-ad daily cap: **$40 CAD**
   - Daily circuit breaker: **$100 CAD**. All spend pauses if it trips.
3. **Every outbound action has an idempotency key.** Keys are unique in the
   database, so retries and crashes cannot fire twice.
   - One lead event → at most one call (key = lead ID).
   - One approval → at most one publish (key = approval ID).
   - One cycle → at most one reallocation (key = cycle ID).
4. **Angry comments always go to a human.** Agents never auto-reply to them,
   never auto-hide them without a human decision, and never argue with a
   customer in public.
5. **No invented claims.** Ads and replies use only the verified facts below.
   No made-up prices, guarantees, or testimonials. If a fact can't be
   verified, flag it; don't publish it.
6. **Kill switches are tested, not theoretical.** Global pause, a pause for
   each department, and a spend freeze. Each is tested in Phase 8 and
   re-tested monthly.

## Owner decisions

| Date | Decision |
|---|---|
| 2026-10-18 | The 48-hour ad cycle judges each variant on its **last 7 days** of results. At ~$50/day, 48 hours rarely reaches the 5-lead winner bar. The cycle still runs every 48 h. |

## Approval timeouts

| Item | Timeout | On timeout |
|---|---|---|
| Ad or post draft | 48 h | Expires. Nothing publishes. |
| Budget reallocation | 24 h | Expires. Budget stays as it is. |
| Reputation reply draft | 12 h | Re-notifies the owner once, then expires. |

Expired approvals are never treated as approved.

## Escalation contacts

| Who | Channel | For |
|---|---|---|
| Owner (Dana Reyes) | Approval bot / dashboard | All approvals and all interrupts |
| Sales lead (fictional: Sam Okafor) | Phone handoff | Callers who ask for a person, big deals |

**Big-deal threshold:** an estimated job value of **$5,000 CAD** or more (for
example a furnace or heat-pump replacement) goes straight to the owner and the
sales lead.

## Interrupt triggers

Each trigger pauses **only its own thread**, notifies the owner with context
and a recommended action, and logs the event to `agent_activity_log`.

1. Weekly budget limit reached
2. Ad rejected by the platform
3. Cost per lead jumps more than 50% above the 7-day average
4. A competitor launches something new
5. An angry comment is spreading (3 or more angry replies or reactions in one
   thread)
6. A caller asks for a person
7. A big deal is detected (value at or above the big-deal threshold)

`growth-director` never overrides an interrupt.

## Brand voice

- Plain, calm, local: a trusted neighbour who happens to be a licensed plumber.
- Say what we do, where, and how fast. No hype, no ALL CAPS, no fear-mongering.
- Canadian spelling (colour, centre, licence as a noun).
- Each piece of content has one clear call to action.

## Verified product facts (the only claims allowed)

- Licensed and insured in Ontario.
- 24/7 emergency line.
- Serving Burlington, Oakville, Hamilton Mountain, Milton.
- Free in-home quotes for furnace, heat-pump, and water-heater replacements.
- Service-call fee: **$129 CAD** (fictional, owner-confirmed for mock data).
- No other prices are verified. If a price isn't listed here, don't state one.

**Banned claims:** "cheapest", "#1", "guaranteed lowest price", any rebate
amount not confirmed by the owner, and invented reviews or star ratings.

## Compliance: CASL (Canada's anti-spam law; we are in Ontario)

- Automated calls, texts, DMs, and emails for commercial purposes need
  **express consent**, clear identification of the business, and a working
  unsubscribe or opt-out.
- The lead-capture form records consent **before** the 60-second callback can
  fire. Speed never excuses missing consent.
- Each consent record stores who consented, when, and the exact wording they
  saw. These live in `leads.consent_*`.
- Consent wording and call scripts must be reviewed before any real leads
  flow. This is a build requirement, not legal advice.

## Consent wording (CASL)

> **DRAFT — must be reviewed before real leads flow** (build plan Section 9). This is a build
> requirement, not legal advice.

- **Version:** `consent-v1`
- **Sender identification (shown on the form):** Northshore Plumbing & Heating, Burlington, Ontario ·
  (905) 555-0100 · hello@northshore.example (fictional)
- **Checkbox wording (must be ticked by the person; never pre-ticked):**

  > Yes, Northshore Plumbing & Heating may call or text me at this number about my request. I can opt out anytime by replying STOP or asking to be removed.

The exact wording, version, and time are stored with every lead. Every confirmation page has an
opt-out link. Opting out withdraws consent for that number and adds it to the do-not-contact list;
the database then refuses any call to it.

## Approved reply templates

lead-qualifier may reply to comments and DMs **only** with these, word for word, with `{link}`
replaced by a personal capture link. Anything a template doesn't cover goes to a human.

| Key | For intents | Text |
|---|---|---|
| `capture-v1` | buying_intent, question | Thanks for reaching out! Pop your number in here and a Northshore team member will call you within a minute: {link} |

## Quote price list

> Fictional prices, owner-confirmed **for the sandbox only**. Replace with real prices before go-live.
> The phone assistant may quote **only** these. Anything else gets a free in-home visit, never a guess.

| Service key | Service | Price (CAD) | Basis |
|---|---|---|---|
| `furnace_tuneup` | Furnace tune-up | 149 | fixed |
| `drain_cleaning` | Drain cleaning | 189 | fixed |
| `emergency_plumbing` | Emergency plumbing visit | 129 | service_call |
| `water_heater` | Water heater replacement | — | in_home_estimate |
| `furnace_replacement` | New furnace | — | in_home_estimate |
| `heat_pump` | Heat pump install | — | in_home_estimate |

## Approved text messages

The phone assistant texts **only** these, word for word, filling in the `{placeholders}`. A reply it doesn't
understand goes to the owner; it never improvises. Every text identifies the business and says how to opt out.

| Key | When | Text |
|---|---|---|
| `quote-fixed-v1` | Lead asked to be texted; service has a fixed price | Hi {first_name}, it's Northshore Plumbing & Heating. Thanks for reaching out! A {service} is ${price} + HST, done by a licensed tech. Want to book a visit? Reply YES and we'll send you times. Reply STOP to opt out. |
| `quote-call-v1` | Service is priced as a service call | Hi {first_name}, it's Northshore Plumbing & Heating. Thanks for reaching out! Our {service} starts with a ${price} service call; parts and labour are quoted on site before any work. Want to book? Reply YES and we'll send you times. Reply STOP to opt out. |
| `quote-visit-v1` | Service needs an in-home estimate | Hi {first_name}, it's Northshore Plumbing & Heating. Thanks for reaching out! For a {service} we give a free in-home quote. Want us to come by? Reply YES and we'll send you times. Reply STOP to opt out. |
| `slots-v1` | Customer replied YES | Great! Here are our next openings: 1) {slot1} 2) {slot2} 3) {slot3}. Reply 1, 2 or 3 to pick a time. |
| `hold-v1` | Customer picked a time | Perfect, we've pencilled you in for {slot}. We'll text you as soon as it's confirmed. |
| `confirmed-v1` | Owner confirmed the booking | You're booked! {service} on {slot} at your place. A licensed Northshore tech will text when they're on the way. Reply STOP to opt out. |
| `reschedule-v1` | Owner declined the time, or it expired | Sorry {first_name}, that time no longer works on our side. Someone from Northshore will call you today to find a better one. |
| `declined-v1` | Customer replied NO | No problem at all, {first_name}. If anything changes, just text us back. Reply STOP to opt out. |

## Agent roster

| Agent | Owns | Never allowed to |
|---|---|---|
| `growth-director` | The loop, dispatching, morning digest | Approve anything; override an interrupt |
| `triage` | Classifying every signal | Send any outbound message |
| `ad-writer` | Ad variants and organic drafts (status `draft`) | Invent a claim, price, or testimonial; publish |
| `media-producer` | Video and voiceover assets for approved scripts | Keep burning credits after the cost threshold or repeated failures |
| `lead-qualifier` | Buying-intent signal → consented phone number | Improvise sales talk; use non-template replies |
| `voice-dispatcher` | **Lead callbacks** (60-second call) and **quote texts** (book by text) | Call or text without consent; call a lead twice for the same event; text anything but an approved template; confirm a booking itself (the owner confirms) |
| `analyst` | Scoring, winner/loser classification, attribution | Make a reallocation itself (it can only recommend one) |
| `reputation-guard` | Review and mention monitoring, reply drafts | Publish anything (it has no publish tool); auto-reply to anger |

## Logging law

Every outbound action, and every decision an agent makes, writes an
`agent_activity_log` row with: agent, action, decision, related entity,
estimated cost, latency, approval ID (if any), and idempotency key.

**If it isn't in the database, it didn't happen.**

## Provider changes

Never swap a provider silently. If an agent changes a provider (for example
for video generation), it records the change here with the cost or quality
difference.

| Date | Change | Reason |
|---|---|---|
| 2026-10-17 | Competitor research: **Meta Ad Library API → mock source (dev) + manual CSV import** from the public Ad Library website | The Ad Library API returns only political/issue ads, plus commercial ads delivered in the EU/UK. Canadian competitors' commercial ads are visible on the website but not via the API. Cost: none. Quality: needs a person (or a future approved tool) to copy sightings; owner to decide on any paid third-party source. |

## Current build phase

**Phases 2–3 built in mock mode.** The webhook receiver verifies real Meta signatures, but only
simulated deliveries have been sent so far (no Meta app yet). The brain (triage, ad-writer) runs on a
deterministic mock model; live Claude calls are off until the owner approves paid usage
(`LLM_MODE=live`, capped by `LLM_DAILY_BUDGET_CAD`). Publishing is simulated: nothing reaches Meta.
Phase 4 (paid ads loop) runs on a simulated ad platform and simulated media: no money moves and no
credits are used. The spend caps above are enforced by the database (`spend_caps`, migration 017).
Phase 5 (lead capture + 60-second callback) runs with a simulated voice agent and calendar: no real
call is placed. The consent wording below is a DRAFT until reviewed.
Customers can also choose to be **texted** a quote and book by text; the owner confirms every booking. Texts
are simulated. Each outside service has an owner on/off switch (dashboard → Connections), enforced by the
database.
Every external integration (Meta, TikTok,
ElevenLabs, Twilio, Higgsfield, Google Calendar, Telegram/Slack, Anthropic API)
is stubbed. No real API keys, no real ad spend, no real calls.
