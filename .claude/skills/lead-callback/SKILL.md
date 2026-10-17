---
name: lead-callback
description: The 60-second voice callback for a consented lead. Verifies consent, enforces one-call-per-lead idempotency, dispatches the voice agent, writes outcome/booking back. Use on every lead.created event.
---

# lead-callback: 60-second voice callback

Owner: `voice-dispatcher`.

## Steps

1. Receive a `lead.created` event.
2. **Consent check:** `leads.consent_given = true`, with `consent_at` and
   `consent_text` stored. If any is missing, stop and log it.
3. **Idempotency:** insert a `calls` row with `idempotency_key = lead ID`. If
   the database rejects it as a duplicate, stop. The lead has already been
   called.
4. **Big-deal check:** if the estimated value is at or above the MUSE.md
   threshold, notify the owner and the sales lead (as well as, or instead of,
   the agent call).
5. Dispatch the ElevenLabs agent via Twilio. **Stubbed in mock mode:** it
   writes a simulated outcome and makes no real call.
6. Write back the transcript summary, outcome, and `answered_at` (speed to
   lead = `answered_at − leads.created_at`). Write an `appointments` row if a
   job was booked.

## Escalation

Route to a human if the caller asks for a person or two attempts have failed.
