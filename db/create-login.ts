/**
 * Creates (or rotates the password of) a least-privilege login role for one service.
 *
 *   DB_LOGIN_PASSWORD='<long random>' npm run db:create-login -- dashboard   # dashboard_login ∈ dashboard_app
 *   DB_LOGIN_PASSWORD='<long random>' npm run db:create-login -- oncu        # oncu_login      ∈ oncu_sync_app
 *   DB_LOGIN_PASSWORD='<long random>' npm run db:create-login -- video       # video_login     ∈ video_app
 *   DB_LOGIN_PASSWORD='<long random>' npm run db:create-login -- mailer      # mailer_login    ∈ mailer_app
 *
 * The password comes from the environment only and never touches the repo.
 */
import pg from "pg";
import { databaseUrl, newClient } from "../src/lib/db.ts";

const SERVICES = { dashboard: "dashboard_app", oncu: "oncu_sync_app", video: "video_app", mailer: "mailer_app" } as const;
const service = (process.argv[2] ?? "dashboard") as keyof typeof SERVICES;
if (!(service in SERVICES)) {
  console.error(`Unknown service "${service}". Use one of: ${Object.keys(SERVICES).join(", ")}`);
  process.exit(1);
}
const group = SERVICES[service];
const login = `${service}_login`;
const password = process.env.DB_LOGIN_PASSWORD ?? "";
if (password.length < 16) {
  console.error("Set DB_LOGIN_PASSWORD to at least 16 random characters.");
  process.exit(1);
}

const client = newClient(databaseUrl());
await client.connect();
try {
  const { rowCount } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [login]);
  // Roles can't take bind parameters for passwords; escapeLiteral / escapeIdentifier quote safely.
  const pw = pg.escapeLiteral(password);
  const role = pg.escapeIdentifier(login);
  if (rowCount) await client.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${pw}`);
  else await client.query(`CREATE ROLE ${role} WITH LOGIN PASSWORD ${pw} NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await client.query(`GRANT ${pg.escapeIdentifier(group)} TO ${role}`);
  const db = new URL(databaseUrl()).pathname.slice(1);
  await client.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(db)} TO ${role}`);
  console.log(`${login} ${rowCount ? "password rotated" : "created"} (member of ${group}).`);
} finally {
  await client.end();
}
