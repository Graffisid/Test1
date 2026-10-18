import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { Notifier } from "@/components/Notifier";
import { Toaster } from "@/components/Toaster";
import { isOwner } from "@/lib/session";
import { logoutAction } from "./auth-actions";
import "./globals.css";

export const metadata: Metadata = {
  title: "Northshore Growth Desk",
  description: "AI social media team — owner dashboard (mock data)",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers(); // every page renders per request, so each gets its own CSP nonce
  const authed = await isOwner();
  return (
    <html lang="en-CA">
      <body>
        <a href="#main" className="skip">Skip to content</a>
        <header className="topbar">
          <Link href="/" className="brand">
            <span className="logo" aria-hidden="true">N</span>
            <span>
              <strong>Northshore</strong>
              <span className="brand-sub">Growth Desk</span>
            </span>
          </Link>
          {authed && (
            <nav aria-label="Main">
              <Link href="/">Today</Link>
              <Link href="/customers">Customers</Link>
              <Link href="/connections">Connections</Link>
              <Link href="/demo">Demo</Link>
              <Link href="/digest">Daily report</Link>
            </nav>
          )}
          <div className="topbar-end">
            <span className="sandbox" role="note"
              title="Practice mode: a made-up business and fake data. Nothing is really posted, spent or called.">
              <span className="sandbox-dot" aria-hidden="true" />
              Sandbox<span className="sr-only">: practice mode with made-up data. Nothing is really posted, spent or called.</span>
            </span>
            {authed && (
              <form action={logoutAction}>
                <button type="submit" className="btn ghost small">Sign out</button>
              </form>
            )}
          </div>
        </header>
        <main id="main">{children}</main>
        {authed && <><Toaster /><Notifier /></>}
      </body>
    </html>
  );
}
