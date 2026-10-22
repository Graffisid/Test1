import type { Metadata } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import { headers } from "next/headers";
import { Icon } from "@/components/Icon";
import { Notifier } from "@/components/Notifier";
import { SideNav } from "@/components/SideNav";
import { Toaster } from "@/components/Toaster";
import { OWNER_NAME } from "@/lib/db";
import { getPendingCount, getProfile } from "@/lib/queries";
import { isOwner } from "@/lib/session";
import { logoutAction } from "./auth-actions";
import "./globals.css";

// ONCU's type pairing, bundled with the app (SIL Open Font License; see app/fonts/LICENSE.txt). No font requests leave the app.
const sans = localFont({ src: "./fonts/HankenGrotesk-latin.woff2", weight: "300 800", variable: "--font-sans", display: "swap" });
const display = localFont({ src: "./fonts/Sora-latin.woff2", weight: "400 700", variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  title: "Northshore Growth Desk",
  description: "AI social media team — owner dashboard (mock data)",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers(); // every page renders per request, so each gets its own CSP nonce
  const authed = await isOwner();
  const pending = authed ? await getPendingCount() : 0;
  const shownName = authed ? (await getProfile()).profile.display_name : OWNER_NAME;
  const initials = shownName.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return (
    <html lang="en-CA" className={`${sans.variable} ${display.variable}`}>
      <body className={authed ? "with-shell" : ""}>
        <a href="#main" className="skip">Skip to content</a>
        {authed ? (
          <div className="app">
            <aside className="sidebar">
              <Link href="/" className="brand">
                <span className="logo" aria-hidden="true">N</span>
                <span><strong>Northshore</strong><span className="brand-sub">Growth Desk</span></span>
              </Link>
              <SideNav pending={pending} />
              <div className="side-foot">
                <span className="sandbox" role="note" title="Practice mode: a made-up business and fake data. Nothing is really posted, spent or called.">
                  <span className="sandbox-dot" aria-hidden="true" />
                  Sandbox<span className="sr-only">: practice mode with made-up data. Nothing is really posted, spent or called.</span>
                </span>
                <div className="me">
                  <Link href="/profile" className="me-link" title="Your profile">
                    <span className="avatar" aria-hidden="true">{initials || "N"}</span>
                    <span className="me-name"><strong>{shownName}</strong><span className="muted small">Owner · profile &amp; settings</span></span>
                  </Link>
                  <form action={logoutAction}>
                    <button type="submit" className="icon-btn" aria-label="Sign out" title="Sign out"><Icon name="logout" /></button>
                  </form>
                </div>
              </div>
            </aside>
            <main id="main" className="content">{children}</main>
          </div>
        ) : (
          <main id="main" className="content solo">{children}</main>
        )}
        {authed && <><Toaster /><Notifier /></>}
      </body>
    </html>
  );
}
