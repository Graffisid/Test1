import "server-only";
import pg, { type QueryResultRow } from "pg";

// numeric/bigint → JS number for display (money and counts here are well within double precision).
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));

// Same database as the system of record. Local default only; production sets DATABASE_URL.
const url = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/ai_social_team";

const globalForPool = globalThis as unknown as { pgPool?: pg.Pool };
export const pool = globalForPool.pgPool ?? new pg.Pool({ connectionString: url, max: 5 });
if (process.env.NODE_ENV !== "production") globalForPool.pgPool = pool;

export async function q<T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await pool.query<T>(sql, params);
  return rows;
}

/** The owner's display name. There is no auth yet — the dashboard binds to localhost only. */
export const OWNER_NAME = process.env.OWNER_NAME || "Dana Reyes";
