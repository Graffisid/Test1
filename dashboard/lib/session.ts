import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "./auth";

/** Defense in depth: every server action and data route re-checks the session, not just the proxy. */
export async function requireOwner(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await verifySession(token))) throw new Error("UNAUTHENTICATED");
}

export async function isOwner(): Promise<boolean> {
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value);
}

/** For pages: send anyone without a valid session to the login page. */
export async function requireOwnerPage(): Promise<void> {
  if (!(await isOwner())) {
    const { redirect } = await import("next/navigation");
    redirect("/login");
  }
}
