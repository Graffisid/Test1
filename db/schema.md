# Database schema

Postgres. Migrations live in `db/migrations/` and run in order (`npm run db:migrate`; `npm run db:reset` starts over,
local databases only). Every service connects with its own least-privilege login:

| Role | Used by | Can do |
|---|---|---|
| `dashboard_app` | the owner dashboard | read; decide statements, videos and messages; edit offerings, lessons, sender details; add contacts |
| `oncu_sync_app` | `oncu:auto`, `oncu:sync` | add ONCU imports (and update the current profile row) |
| `video_app` | the video worker | claim queued videos and record render results |
| `mailer_app` | the mailer | read approved messages and record delivery |

`001_foundation.sql` holds the shared helpers: `set_updated_at()`, and `is_agent_name()`, which stops an automated
service from being recorded as the person who decided something.

## Trisanga: ONCU Insights and stories (migration 002)

| Table | What it holds | Who writes |
|---|---|---|
| `oncu_imports` | One row per ONCU sync: ONCU commit, content hash (unique), counts | `oncu_sync_app` (insert only) |
| `credit_unions` | Current profile of each credit union (the only row a sync updates in place) | `oncu_sync_app` |
| `cu_metric_values` | Audited/official numbers by year **per import** (history) with ONCU classification and source ids | `oncu_sync_app` (insert only) |
| `cu_sources` | ONCU source list per import | `oncu_sync_app` (insert only) |
| `cu_facts` | ONCU evidence records per import, with ONCU's own type, verification and approval labels | `oncu_sync_app` (insert only) |
| `offerings` | What Trisanga offers (draft wording the owner edits) | `dashboard_app` (wording and on/off only) |
| `pain_rules` | The seven pain-point rules and the offering that answers each | `dashboard_app` (mapping and on/off only) |
| `claim_approvals` | Owner decisions on story statements, pinned to a SHA-256 of the exact numbers | `dashboard_app` (insert only) |

Import history and approvals are append-only for every role (triggers). An agent name can never be recorded as the decider.

## Trisanga: video studio (migration 003)

| Table | What it holds | Who writes |
|---|---|---|
| `videos` | One requested video: format, frozen storyboard (every word and number), the approved statements it uses (`claims`: key + hash), render result (file name, SHA-256, size, duration), owner decision | `dashboard_app` requests and decides; `video_app` records the render |

`videos_guard` (trigger) refuses: a request using a statement that isn't the owner's latest "approved" decision with that
exact hash; any storyboard edit; skipping a status (queued → rendering → ready → approved/rejected; failed → queued); approving
when a statement was since withdrawn; deleting a video; deciding twice. `video_claims_approved()` is the shared check.

## Trisanga: sharing and learning (migration 004)

| Table | What it holds | Who writes |
|---|---|---|
| `sender_profile` | One row: the sender's name, title, organization, email, mailing address, website (CASL identification) | `dashboard_app` |
| `contacts` | People at credit unions, with the CASL basis (`express`, `published`, `relationship`), evidence and date; unsubscribes | `dashboard_app` (add; unsubscribe only) |
| `lessons` | The education library: title, summary, lesson, the pain point it explains, draft/published | `dashboard_app` (wording and status only) |
| `shares` | One message: approved video + contact, subject, body, lessons, status, approval, delivery, outcome | `dashboard_app` drafts and decides; `mailer_app` records delivery |

`shares_guard` refuses: a share of a video that isn't approved, or with a contact at another credit union; drafting to,
approving for or sending to a contact who unsubscribed or whose relationship consent is over two years old; approving
without the sender's name and mailing address; editing after approval; the dashboard marking a message sent; an
outcome before sending; deletes. `contacts_guard` makes unsubscribes permanent and cancels unsent messages to that
person. `contact_sendable()` and `sender_complete()` are the shared checks.
