import { ActionForm } from "@/components/ActionForm";
import { requireOwnerPage } from "@/lib/session";
import { getOfferings, getPortfolio, getRules } from "@/lib/oncu";
import { mapRuleAction, saveOfferingAction } from "../trisanga-actions";

export const dynamic = "force-dynamic";

export default async function Offerings() {
  await requireOwnerPage();
  const [offerings, rules, cus] = await Promise.all([getOfferings(), getRules(), getPortfolio()]);
  const count = (rule: string) => cus.filter((c) => c.pains.some((p) => p.key === rule)).length;

  return (
    <>
      <header className="page-head rise">
        <div>
          <p className="eyebrow">Offerings</p>
          <h1>What Trisanga solves</h1>
          <p className="page-sub">A first draft. Edit the wording so it sounds like Trisanga: it&apos;s what a credit union hears after its pain point,
            and what it can learn from us. Then choose which offering answers each pain point.</p>
        </div>
      </header>

      <section className="card rise" aria-labelledby="map-h">
        <header className="card-head"><div><p className="eyebrow">Pain point → offering</p><h2 id="map-h">How each pain point is answered</h2></div></header>
        <div className="table-wrap">
          <table className="comp-table map-table">
            <thead><tr><th>Pain point</th><th>When it shows up</th><th>Credit unions</th><th>Answered by</th></tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.key}>
                  <td><strong>{r.title}</strong></td>
                  <td className="muted small">{r.test}</td>
                  <td>{count(r.key)}</td>
                  <td>
                    <ActionForm action={mapRuleAction} className="map-form">
                      <input type="hidden" name="rule" value={r.key} />
                      <select name="offering_key" defaultValue={r.offering_key} aria-label={`Offering for ${r.title}`}>
                        {offerings.map((o) => <option key={o.key} value={o.key}>{o.title}</option>)}
                      </select>
                      <label className="check"><input type="checkbox" name="active" defaultChecked={r.active} /> On</label>
                      <button type="submit" className="btn small">Save</button>
                    </ActionForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="offer-grid">
        {offerings.map((o) => (
          <section key={o.key} className="card rise offer" aria-label={o.title}>
            <ActionForm action={saveOfferingAction} className="offer-form">
              <input type="hidden" name="key" value={o.key} />
              <label>Name<input name="title" defaultValue={o.title} maxLength={80} required /></label>
              <label>Promise <span className="muted small">(one line)</span><input name="promise" defaultValue={o.promise} maxLength={200} required /></label>
              <label>How we help<textarea name="how_we_help" defaultValue={o.how_we_help} maxLength={800} rows={4} required /></label>
              <label>What they learn <span className="muted small">(the education angle)</span><textarea name="learn" defaultValue={o.learn} maxLength={400} rows={2} required /></label>
              <div className="offer-foot">
                <label className="check"><input type="checkbox" name="active" defaultChecked={o.active} /> Offered</label>
                <span className="muted small">{o.updated_by ? `Edited by ${o.updated_by}` : "Draft"}</span>
                <button type="submit" className="btn small primary">Save</button>
              </div>
            </ActionForm>
          </section>
        ))}
      </div>
    </>
  );
}
