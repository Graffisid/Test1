import pg from "pg";

// Local default only. Real deployments set DATABASE_URL in the host's secret store.
export const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/ai_social_team";

export function databaseUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

export function newClient(url = databaseUrl()): pg.Client {
  return new pg.Client({ connectionString: url });
}
