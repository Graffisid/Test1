# Trisanga Story Studio

Part of Trisanga's **Learning** pillar (young leaders and co-operative development), alongside Consulting and Digital
Products (ONCU Insights), built on its values: Curiosity · Creativity · Collaboration.

The studio reads each Ontario credit union's history from **ONCU Insights** and tells its story from its own audited
numbers. It names what is in the way, matches each pain point to how Trisanga can help, and turns the story into a
short branded video. The owner can then share the video with a contact at that credit union, together with
plain-language learning notes.

**The rule:** nothing reaches a credit union without the owner's approval, at every step.
- **Statements:** each fact is approved on its own, and the approval is tied to the exact numbers.
- **Videos:** a video uses only approved statements, and the video itself is approved too.
- **Messages:** every message is approved before it goes out, and Canada's anti-spam law (CASL) is enforced by the database.
- **ONCU changes:** if ONCU changes a figure, the statements built on it wait for the owner again.

## Phases

| Phase | What | State |
|---|---|---|
| 1 | ONCU connector with import history, story and pain-point engine, owner approvals, editable offerings | Done |
| 2 | Video studio: storyboards from approved statements, MP4s (9:16 and 16:9) rendered locally, video approval; Trisanga brand | Done |
| 3 | Sharing with credit unions (CASL consent, owner-approved, outbox), education library, automatic ONCU sync, Northshore code retired | Done |

## Quick start

```bash
git clone https://github.com/Graffisid/oncu-app ../oncu-app   # ONCU Insights, next to this repo (read-only)
npm install && (cd dashboard && npm install)
npm install --no-save playwright-core@1.56.1 && npx playwright install chromium   # for videos (free, local)
brew install ffmpeg                                            # for videos (macOS; any ffmpeg with libx264 works)
npm run sandbox
```

`npm run sandbox` does the following:
- Resets a local database.
- Creates a least-privilege login for each service.
- Imports ONCU's committed `main` branch.
- Starts the dashboard on <http://127.0.0.1:3000>, plus the video worker, the mailer (outbox only) and the automatic ONCU sync.

Sign in with the password it prints. Use `npm run sandbox -- --keep` to keep your approvals, videos and contacts.

A typical walk-through:
1. **Profile:** add your name and mailing address. CASL requires them in every message.
2. **Learning** and **Offerings:** rewrite the draft notes and offerings in Trisanga's voice, then publish the notes.
3. **A credit union:** approve its statements, then press **Make vertical 9:16**.
4. **Videos:** watch the video, then approve it.
5. **A credit union → Contacts:** add a person you may write to, with the consent basis and evidence.
6. **Sharing:** start a draft, edit it, and approve it. The mailer writes it to `.outbox/` as an email file.

## How it works

- **ONCU connector** (`src/oncu/connector.ts`; `workflows/oncu-auto.ts` and `oncu-sync.ts`):
  - `oncu:auto` runs `git fetch` on your ONCU checkout and reads `oncu/data` from the committed branch with
    `git archive`. It never changes your working copy.
  - Each new commit becomes one **import**. Every value is kept against its import, so past numbers stay next to
    current ones. Unchanged data is skipped.
  - It keeps only the numbers ONCU classifies as audited, official or calculated from those. Ratios are dropped
    where ONCU marks the base figures as unverified.
  - It runs every 6 hours in the sandbox (`ONCU_AUTO_HOURS`). Use `npm run oncu:auto -- --once` for cron or launchd.
- **Story engine** (`dashboard/lib/story.ts`):
  - It builds year chapters, trends over the whole period, and seven pain-point rules.
  - Each statement lists its figures, ONCU's classification and its sources.
  - ONCU's interpretations, member and employee voice, and pending findings appear as context only.
- **Approvals:** append-only, and pinned to a SHA-256 of the numbers. ONCU data → *What changed* lists the
  credit unions whose numbers moved and the approved statements to review again.
- **Video studio** (`dashboard/lib/storyboard.ts`, `src/video/render.ts`, `workflows/video-worker.ts`):
  - A storyboard is built from approved statements only and frozen when the video is requested.
  - A headless browser draws each frame with the Trisanga fonts and glass logo embedded, and ffmpeg encodes an
    H.264 MP4: 1080×1920 or 1920×1080, about 75 seconds, about 2 minutes to render.
  - No paid service and no network. Files stay in `.videos/`.
- **Sharing** (`dashboard/app/sharing`, `dashboard/lib/message.ts`, `workflows/mailer.ts`):
  - **Contacts** record the CASL basis (express consent, a published business address with a role-relevant
    message, or an existing relationship within two years), with evidence and date.
  - **Drafts** are pre-written, include the learning notes that match the credit union's pain points, and are
    edited and approved by the owner.
  - **The mailer** checks the video file's SHA-256, attaches it, and adds the CASL footer and a `List-Unsubscribe`
    header. It writes a standard `.eml` to `.outbox/`. Nothing is emailed: `MAIL_MODE=outbox` is the only mode.
  - **Outcomes** (replied, meeting booked, not interested, unsubscribed) are recorded by the owner. Unsubscribes
    are permanent and cancel anything unsent.
- **Education library** (`/learning`): eight plain-language notes for boards and teams, one per pain point plus
  "Reading your financial statements as a director". They are drafts until the owner publishes them.

### Dashboard

- **Overview:** the roster, which credit unions are ready for a story, pain points by offering, and what to review next.
- **Credit unions:** all 48, with search and a pain-point filter.
- **A credit union's page:**
  - the story video panel;
  - contacts and the learning notes for that credit union;
  - audited charts;
  - pain points with Trisanga's answer, and the year-by-year story;
  - ONCU context, which is never used in videos;
  - its import history.
- **Videos:** player, storyboard, Approve / Decline, and Download after approval.
- **Sharing:** new messages from approved videos, the drafts and their email previews, approval, the outbox file, and outcomes.
- **Learning**, **Offerings**, **ONCU data** (what changed, plus every import) and **Profile** (sender details).

## Layout

```
src/oncu/connector.ts        ONCU reader and importer
src/video/render.ts          frame renderer + ffmpeg encoder
workflows/oncu-auto.ts       automatic ONCU sync (git, read-only)
workflows/oncu-sync.ts       import from a plain folder
workflows/video-worker.ts    renders queued videos
workflows/mailer.ts          writes approved messages to the outbox
db/migrations/               001 foundation · 002 ONCU and stories · 003 videos · 004 sharing and learning
dashboard/                   Next.js 16 owner dashboard (strict CSP, least-privilege DB login)
tests/                       node:test suites (fictional fixture; no real credit union data in this repo)
```

## Checks

```bash
npm test                          # database rules, connector, stories, videos, sharing (needs a local Postgres)
npm run typecheck
cd dashboard && npm run build && npm run security-check
```

The render test runs when Playwright and ffmpeg are installed, and is skipped otherwise.

See [SECURITY.md](./SECURITY.md) for the threat model and [db/schema.md](./db/schema.md) for the tables.

## History

This repository started as "Northshore", an AI social media team for a fictional plumber. It was converted to the
Trisanga Story Studio in three phases, and the Northshore code was retired in Phase 3. It is still in git history.
