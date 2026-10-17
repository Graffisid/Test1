import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
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
          <div className="brand">
            <span className="logo" aria-hidden="true">N</span>
            <div>
              <strong>Northshore Growth Desk</strong>
              <span className="muted small">Northshore Plumbing &amp; Heating · Burlington, ON</span>
            </div>
          </div>
          {authed && (
            <nav aria-label="Main">
              <Link href="/">Overview</Link>
              <Link href="/digest">Morning digest</Link>
              <form action={logoutAction}>
                <button type="submit" className="btn ghost small">Sign out</button>
              </form>
            </nav>
          )}
        </header>
        <p className="mock-banner" role="note">
          <span aria-hidden="true">⚠</span> Mock mode — fictional business, seeded data. No real ad spend, calls, or publishing.
          Approvals are recorded; nothing goes out.
        </p>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
