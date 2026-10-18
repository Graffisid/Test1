/**
 * Starts the webhook receiver.
 *
 *   npm run ingest:start
 *
 * Required env (see .env.example): INGEST_DATABASE_URL (a login in ingest_app — never the superuser),
 * META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN. Binds 127.0.0.1:3001 by default; Meta needs a public
 * HTTPS URL, which means a TLS reverse proxy / tunnel in front of this (Phase 2 real-world step).
 */
import pg from "pg";
import { createIngestServer } from "./server.ts";

function required(name: string, min = 1): string {
  const v = process.env[name] ?? "";
  if (v.length < min) {
    console.error(`${name} must be set${min > 1 ? ` (at least ${min} characters)` : ""}. See .env.example.`);
    process.exit(1);
  }
  return v;
}

const pool = new pg.Pool({ connectionString: required("INGEST_DATABASE_URL"), max: 5, statement_timeout: 10_000 });
const { rows } = await pool.query<{ rolsuper: boolean; member: boolean }>(
  `SELECT rolsuper, pg_has_role(current_user, 'ingest_app', 'member') AS member FROM pg_roles WHERE rolname = current_user`);
if (rows[0]?.rolsuper && process.env.ALLOW_SUPERUSER_DB !== "1") {
  console.error("Refusing to run the webhook receiver as a database superuser. Use a login in ingest_app.");
  process.exit(1);
}
if (!rows[0]?.rolsuper && !rows[0]?.member) {
  console.error("The receiver's database role is not a member of ingest_app.");
  process.exit(1);
}

// Lead-capture form + opt-out (lead-qualifier), enabled when its own least-privilege login is configured.
const captureUrl = process.env.QUALIFIER_DATABASE_URL;
const capture = captureUrl ? {
  pool: new pg.Pool({ connectionString: captureUrl, max: 5, statement_timeout: 10_000 }),
  secret: required("CAPTURE_LINK_SECRET", 32),
  trustProxy: process.env.TRUST_PROXY === "1",
} : undefined;

// Inbound texts (Twilio), enabled when the auth token is configured.
const smsToken = process.env.TWILIO_AUTH_TOKEN;
const sms = smsToken ? {
  authToken: required("TWILIO_AUTH_TOKEN", 16),
  publicUrl: `${(process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3001").replace(/\/$/, "")}/webhooks/sms`,
} : undefined;

// The owner's WhatsApp approvals (Twilio WhatsApp), enabled when the auth token is configured.
const whatsapp = smsToken ? {
  authToken: smsToken,
  publicUrl: `${(process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3001").replace(/\/$/, "")}/webhooks/whatsapp`,
} : undefined;

const server = createIngestServer({
  pool,
  capture,
  sms,
  whatsapp,
  appSecret: required("META_APP_SECRET", 16),
  verifyToken: required("META_WEBHOOK_VERIFY_TOKEN", 16),
  ownIds: new Set([process.env.META_PAGE_ID, process.env.META_INSTAGRAM_ACCOUNT_ID].filter((x): x is string => !!x)),
});
const host = process.env.INGEST_HOST || "127.0.0.1";
const port = Number(process.env.INGEST_PORT || 3001);
server.listen(port, host, () => console.log(`webhook receiver listening on http://${host}:${port}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
