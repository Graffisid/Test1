import Link from "next/link";

/** Our own 404 (Next's built-in one uses inline styles, which the strict CSP blocks). */
export default function NotFound() {
  return (
    <div className="card rise note-card">
      <div>
        <h1>That page isn&apos;t here</h1>
        <p className="muted">It may have moved when the app became the Trisanga Story Studio.</p>
        <p><Link href="/" className="btn small">Go to the overview</Link></p>
      </div>
    </div>
  );
}
