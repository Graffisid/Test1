import { ActionForm } from "@/components/ActionForm";
import { requireOwnerPage } from "@/lib/session";
import { getLessons, getRules } from "@/lib/oncu";
import { saveLessonAction } from "../sharing-actions";

export const dynamic = "force-dynamic";

export default async function Learning() {
  await requireOwnerPage();
  const [lessons, rules] = await Promise.all([getLessons(), getRules()]);
  const rule = new Map(rules.map((r) => [r.key, r.title]));
  const published = lessons.filter((l) => l.status === "published").length;
  return (
    <>
      <header className="page-head rise">
        <div>
          <p className="eyebrow">Learning</p>
          <h1>The education <em>library</em></h1>
          <p className="page-sub">Short, plain-language notes for credit union boards and teams, one for each pain point plus the basics. Published notes can be
            added to a message, and the matching ones are suggested for each credit union. These are my first drafts: make them yours.</p>
        </div>
        <span className="pill accent">{published} of {lessons.length} published</span>
      </header>
      <div className="offer-grid">
        {lessons.map((l) => (
          <section key={l.key} className="card rise offer" aria-label={l.title}>
            <p className="eyebrow">{l.rule_key ? `For: ${rule.get(l.rule_key) ?? l.rule_key}` : "For every board"}</p>
            <ActionForm action={saveLessonAction} className="offer-form">
              <input type="hidden" name="key" value={l.key} />
              <label>Title<input name="title" defaultValue={l.title} maxLength={120} required /></label>
              <label>Summary <span className="muted small">(one or two lines)</span><textarea name="summary" defaultValue={l.summary} maxLength={300} rows={2} required /></label>
              <label>The lesson<textarea name="body" defaultValue={l.body} maxLength={4000} rows={7} required /></label>
              <div className="offer-foot">
                <label className="check"><input type="checkbox" name="published" defaultChecked={l.status === "published"} /> Published</label>
                <span className="muted small">{l.updated_by ? `Edited by ${l.updated_by}` : "Draft by Claude"}</span>
                <button type="submit" className="btn small primary">Save</button>
              </div>
            </ActionForm>
          </section>
        ))}
      </div>
    </>
  );
}
