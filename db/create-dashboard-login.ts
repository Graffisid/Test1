/**
 * Creates (or rotates the password of) the dashboard's login role, `dashboard_login`, as a member
 * of the least-privilege `dashboard_app` role from migration 014.
 *
 *   DASHBOARD_DB_PASSWORD='<long random password>' npm run db:create-dashboard-login
 *
 * The password comes from the environment only, and never touches the repo or shell history files.
 */
import pg from "pg";
import { databaseUrl, newClient } from "../src/lib/db.ts";

const password = process.env.DASHBOARD_DB_PASSWORD ?? "";
if (password.length < 16) {
  console.error("Set DASHBOARD_DB_PASSWORD to at least 16 random characters.");
  process.exit(1);
}

const client = newClient(databaseUrl());
await client.connect();
try {
  const { rowCount } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_login'");
  // Roles can't take bind parameters for passwords; escapeLiteral quotes safely.
  const pw = pg.escapeLiteral(password);
  if (rowCount) await client.query(`ALTER ROLE dashboard_login WITH LOGIN PASSWORD ${pw}`);
  else await client.query(`CREATE ROLE dashboard_login WITH LOGIN PASSWORD ${pw} NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await client.query("GRANT dashboard_app TO dashboard_login");
  const db = new URL(databaseUrl()).pathname.slice(1);
  await client.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(db)} TO dashboard_login`);
  console.log(`dashboard_login ${rowCount ? "password rotated" : "created"} (member of dashboard_app).`);
} finally {
  await client.end();
}
