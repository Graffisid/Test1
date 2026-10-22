import "server-only";
import pg, { type QueryResultRow } from "pg";

// numeric/bigint → JS number for display (money and counts here are well within double precision).
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));

/**
 * The dashboard must connect as a least-privilege login role that is a member of `dashboard_app`
 * (see db/migrations/014_security.sql and README). It refuses to run as a database superuser,
 * so a bug here can never drop tables, rewrite leads, or edit the audit log.
 */
function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set for the dashboard. See dashboard/.env.example.");
  return url;
}

const globalForPool = globalThis as unknown as { pgPool?: pg.Pool; pgRoleChecked?: Promise<void> };

function getPool(): pg.Pool {
  if (!globalForPool.pgPool) {
    globalForPool.pgPool = new pg.Pool({ connectionString: connectionString(), max: 5, statement_timeout: 10_000 });
  }
  return globalForPool.pgPool;
}

async function checkRole(p: pg.Pool): Promise<void> {
  const { rows } = await p.query<{ rolsuper: boolean; member: boolean }>(
    `SELECT r.rolsuper, pg_has_role(current_user, 'dashboard_app', 'member') AS member
     FROM pg_roles r WHERE r.rolname = current_user`);
  const role = rows[0];
  if (role?.rolsuper && process.env.ALLOW_SUPERUSER_DB !== "1") {
    throw new Error("Refusing to run the dashboard as a database superuser. Use a login role in dashboard_app (see README).");
  }
  if (!role?.rolsuper && !role?.member) {
    throw new Error("The dashboard's database role is not a member of dashboard_app (see README).");
  }
}

async function ready(): Promise<pg.Pool> {
  const p = getPool();
  globalForPool.pgRoleChecked ??= checkRole(p).catch((err) => {
    globalForPool.pgRoleChecked = undefined;
    throw err;
  });
  await globalForPool.pgRoleChecked;
  return p;
}

export const pool = {
  connect: async () => (await ready()).connect(),
};

export async function q<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await (await ready()).query<T>(sql, params);
  return rows;
}

/** The owner's display name, used when recording decisions. */
export const OWNER_NAME = process.env.OWNER_NAME || "Dana Reyes";
