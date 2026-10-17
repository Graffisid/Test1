"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, SESSION_TTL_S, authConfig, checkPassword, createSession } from "@/lib/auth";

// Brute-force protection: after 5 failed attempts in 15 minutes, logins are locked for 15 minutes.
// In-memory (single process). Note: this also means an attacker who can reach the login page can
// temporarily lock the owner out — acceptable for a localhost-only tool, revisit when hosted.
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const g = globalThis as unknown as { loginFailures?: number[] };
g.loginFailures ??= [];

export interface LoginState { error: string | null }

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const cfg = authConfig();
  if (!cfg.ok) return { error: "The dashboard is not configured. Set DASHBOARD_PASSWORD and SESSION_SECRET." };

  const now = Date.now();
  g.loginFailures = g.loginFailures!.filter((t) => now - t < WINDOW_MS);
  if (g.loginFailures.length >= MAX_FAILURES) {
    return { error: "Too many failed attempts. Try again in 15 minutes." };
  }

  const password = String(form.get("password") ?? "").slice(0, 256);
  if (!(await checkPassword(password))) {
    g.loginFailures.push(now);
    await new Promise((r) => setTimeout(r, 400)); // slow down guessing
    return { error: "Incorrect password." };
  }
  g.loginFailures = [];

  const h = await headers();
  const https = h.get("x-forwarded-proto") === "https";
  (await cookies()).set(SESSION_COOKIE, await createSession(), {
    httpOnly: true,
    sameSite: "strict",
    secure: https,
    path: "/",
    maxAge: SESSION_TTL_S,
  });
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
