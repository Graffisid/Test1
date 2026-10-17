/**
 * Guard for destructive scripts (seed truncates every table; reset drops the schema).
 * They only run against a local database unless ALLOW_DESTRUCTIVE_DB=1 is set explicitly.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function assertLocalDatabase(url: string, action: string): void {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`${action}: DATABASE_URL is not a valid URL.`);
  }
  if (!LOCAL_HOSTS.has(host) && process.env.ALLOW_DESTRUCTIVE_DB !== "1") {
    throw new Error(
      `${action} refused: it would wipe data on "${host}". It only runs against a local database ` +
      `unless ALLOW_DESTRUCTIVE_DB=1 is set.`);
  }
}
