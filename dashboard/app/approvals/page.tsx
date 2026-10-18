import { ApprovalCard, type ApprovalView } from "@/components/ApprovalCard";
import { Icon } from "@/components/Icon";
import { requireOwnerPage } from "@/lib/session";
import { AGENT_LABEL, KIND_COPY, dateTime, relative } from "@/lib/format";
import { expireStaleApprovals, getPendingApprovals, getRecentDecisions, type ApprovalRow } from "@/lib/queries";

export const dynamic = "force-dynamic";

function toView(a: ApprovalRow, now: number): ApprovalView {
  const copy = KIND_COPY[a.kind] ?? { label: a.kind, ifApproved: "It goes ahead." };
  return {
    id: a.id, kind: a.kind, kindLabel: copy.label, ifApproved: copy.ifApproved, title: a.title, summary: a.summary,
    payload: a.payload, original_payload: a.original_payload, requestedBy: AGENT_LABEL[a.requested_by_agent] ?? a.requested_by_agent,
    status: a.status, edited: a.edited, needs_fact_check: !!a.needs_fact_check, createdLabel: relative(a.created_at, now),
    expiresLabel: relative(a.expires_at, now), decidedLabel: a.decided_at ? dateTime(a.decided_at) : null,
    decided_by: a.decided_by, decision_note: a.decision_note, leadId: a.lead_id,
  };
}

export default async function Approvals() {
  await requireOwnerPage();
  await expireStaleApprovals();
  const [pending, decided] = await Promise.all([getPendingApprovals(), getRecentDecisions(8)]);
  const now = Date.now();
  const n = pending.length;
  return (
    <>
      <header className="page-head rise">
        <div>
          <p className="eyebrow">Needs your OK</p>
          <h1>{n ? `${n} ${n === 1 ? "item is" : "items are"} waiting for you` : "You're all caught up"}</h1>
          <p className="page-sub">Nothing is posted, spent or booked until you approve it. Items you don&apos;t decide on expire — never approved by silence.</p>
        </div>
      </header>
      <section id="approvals" aria-label="Waiting for your decision" className="queue">
        {n === 0 && (
          <div className="empty-state rise"><Icon name="check" /><p>New drafts from your team will show up here.</p></div>
        )}
        {pending.map((a) => <ApprovalCard key={a.id} a={toView(a, now)} />)}
        {decided.length > 0 && (
          <details className="decided">
            <summary>Recently decided ({decided.length})</summary>
            {decided.map((a) => <ApprovalCard key={a.id} a={toView(a, now)} />)}
          </details>
        )}
      </section>
    </>
  );
}
