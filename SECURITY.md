# Security

What the Trisanga Story Studio protects against, how each protection works, how to verify it, and what is still open.

No software is "totally secure". The goal is that every risk we know about is either closed and tested, or written
down below with its mitigation.

## Threat model (current build: runs locally; ONCU data is public-source research)

### The dashboard

| Threat | Protection | Verified by |
|---|---|---|
| Someone else uses the dashboard | Owner password login. Sessions are HMAC-signed, expire after 12 h, and live in an `HttpOnly`, `SameSite=Strict` cookie. Every page, file route and server action re-checks the session. Before sign-in only `/login` and the logo are reachable. | `npm run security-check`, browser tests |
| Password guessing | Constant-time comparison. 5 failures in 15 min locks login for 15 min, and each failure is delayed. | Browser test |
| DNS rebinding | Host allowlist (`ALLOWED_HOSTS`). Any other `Host` gets **421**. | `security-check` |
| CSRF | `SameSite=Strict` cookie, **and** every POST must carry an `Origin` matching the Host. Server actions also check origin. | `security-check` |
| Clickjacking | `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'`. | `security-check` |
| XSS | React escaping; no `dangerouslySetInnerHTML` or `eval`. Strict CSP: scripts need a per-request nonce; no inline styles. Our own 404 page keeps that true for unknown URLs. | `security-check`, browser console checks |
| SQL injection | Every query is parameterised. | Code review |
| A dashboard bug damaging data | The dashboard connects as `dashboard_login` (in `dashboard_app`) and **refuses to start as a superuser**. Column-level grants only: it can't delete anything, can't write ONCU data, can't mark a message sent, and can't change a video's storyboard. | `tests/phase9`, `phase10`, `phase11` |
| Leaking internals | Generic errors in the browser. No `X-Powered-By`. `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. | `security-check` |

### ONCU data and stories

| Threat | Protection | Verified by |
|---|---|---|
| A bad or tampered ONCU file | Size-limited, schema-validated; a file whose id doesn't match its name is refused; only `https`/`http` links are kept (`javascript:` is dropped). | `tests/phase9-trisanga-oncu.test.ts` |
| Changing the user's ONCU folder | `oncu:auto` only runs `git fetch` and reads the committed branch with `git archive` into a temporary folder; the working copy is never changed. The connector has no write path to ONCU. | `tests/phase11` (working copy unchanged) |
| Rewriting the past | Imported rows and approvals are append-only for every role, the app's included. | `tests/phase9` |
| An unapproved or stale fact in a story | Statements use only audited/official numbers; ratios are dropped when ONCU marks the base figures unverified. Approvals are pinned to a SHA-256 of the exact figures and recomputed on the server (the browser never sends text or hashes). A changed ONCU figure sends the statement back for review. | `tests/phase9` |

### Videos

| Threat | Protection | Verified by |
|---|---|---|
| A video saying something unapproved | The storyboard is built only from approved statements, frozen at request time, and drawn verbatim. The database refuses a video using an unapproved statement, any storyboard edit, skipped statuses, and approving after a statement was withdrawn; the dashboard also refuses if ONCU's numbers changed. | `tests/phase10-video-studio.test.ts` |
| Video files leaking | Files stay in `.videos/` (mode 700). Served only to the signed-in owner, by the database file name (never a path from the request), with HTTP Range; download only after approval. The renderer loads no network resources. | `tests/phase10`, browser test |
| Render worker compromise | `video_app` can claim queued videos and record results, nothing else (no approvals, no contacts, no ONCU writes). | `tests/phase10` |

### Sharing with credit unions (CASL)

| Threat | Protection | Verified by |
|---|---|---|
| Messaging someone without a lawful basis | Every contact records the CASL basis (express consent, conspicuously published business address with a role-relevant message, or an existing relationship) with evidence and date. An existing-relationship basis lapses after two years. The database refuses drafts and sends to anyone unsubscribed or lapsed. | `tests/phase11-sharing-learning.test.ts` |
| A message missing the required identification | The mailer adds the sender's name, organization, website, mailing address, why the person is receiving it, an unsubscribe instruction (honoured within 10 business days) and a `List-Unsubscribe` header. Approval is refused until the sender's name and mailing address are filled in. | `tests/phase11` |
| Sending without the owner's approval, or after an edit | Only the owner can approve; only the mailer role can mark a message sent, and only from "approved". The message is frozen once approved. An agent or service name can't be recorded as the approver. | `tests/phase11` |
| An unsubscribe being ignored | Unsubscribes are permanent (a trigger refuses undoing them) and cancel every unsent message to that person. | `tests/phase11` |
| The wrong file attached | The mailer checks the video's SHA-256 against the approved video before attaching it; a mismatch fails the message. | `tests/phase11` |
| Email header injection | Header values have line breaks removed; non-ASCII is RFC 2047 encoded. | `tests/phase11` |
| Accidental real email | `MAIL_MODE=outbox` is the only mode: messages are written as `.eml` files to `.outbox/` (mode 700). Nothing leaves the machine. | Code review |

### Secrets and dependencies

| Threat | Protection | Verified by |
|---|---|---|
| Secrets in the repo | Only `.env.example` files (names, no values) are tracked; `.env*`, `.sandbox/`, `.videos/` and `.outbox/` are gitignored. Login passwords come from the environment, never SQL files. | Repo scan |
| Wiping a real database by accident | `db:reset` and the sandbox refuse any non-local host unless `ALLOW_DESTRUCTIVE_DB=1`. | Code review |
| Malicious or compromised dependencies | Runtime: `pg` and `zod` (root), Next.js/React (dashboard). Playwright is optional and loaded only if installed. `npm audit`: 0 vulnerabilities. | `npm audit` |

## Running securely

```bash
# 1. Logins for each service (from the repo root)
DB_LOGIN_PASSWORD="$(openssl rand -hex 24)" npm run db:create-login -- dashboard
DB_LOGIN_PASSWORD="$(openssl rand -hex 24)" npm run db:create-login -- oncu     # also: video, mailer

# 2. dashboard/.env.local (gitignored, chmod 600) — see dashboard/.env.example
#    DATABASE_URL=postgres://dashboard_login:<that password>@localhost:5432/ai_social_team
#    DASHBOARD_PASSWORD=<12+ chars>
#    SESSION_SECRET=<openssl rand -base64 48>

# 3. Verify
npm test
cd dashboard && npm run build && npm start
npm run security-check                     # in another terminal
```

`npm run sandbox` does all of this with fresh random passwords on every start.

## Still open

1. **No MFA, single owner.** Before hosting anywhere but localhost, put it behind TLS and an identity provider with 2FA.
2. **Login lockout can be triggered by anyone who reaches the login page.** It is in memory and per process; when hosted,
   rate-limit per IP at the proxy instead.
3. **Real email delivery isn't built.** It needs the owner's approval of a provider and its cost, SPF/DKIM/DMARC on
   trisanga.ca, and a monitored unsubscribe inbox. Keep the outbox-only rule until then.
4. **The CASL wording and consent bases need legal review** before any message reaches a real person. "Published address"
   applies only when the message relates to the person's role and the page doesn't say they don't want messages.
5. **Data at rest is unencrypted locally.** Contacts are personal information under PIPEDA. Use a Canadian-region
   managed database with encryption and backups for anything hosted.
6. **Keep dependencies patched.** Re-run `npm audit` and `npm audit signatures` regularly.

## Reporting

If you find a security issue, tell the owner directly. Don't open a public issue.
