const MAP: Record<string, { icon: string; label: string; tone: string }> = {
  ok: { icon: "●", label: "Done", tone: "neutral" },
  interrupt: { icon: "⏸", label: "Paused, needs you", tone: "critical" },
  escalated: { icon: "⚑", label: "Sent to you", tone: "serious" },
  blocked: { icon: "⛔", label: "Blocked", tone: "warning" },
  error: { icon: "✕", label: "Error", tone: "critical" },
  pending: { icon: "◷", label: "Waiting", tone: "warning" },
  approved: { icon: "✓", label: "Approved", tone: "good" },
  rejected: { icon: "✕", label: "Declined", tone: "critical" },
  expired: { icon: "⌛", label: "Expired", tone: "neutral" },
};

/** Status always ships icon + label — color never carries meaning alone. */
export function StatusChip({ status }: { status: string }) {
  const s = MAP[status] ?? { icon: "●", label: status, tone: "neutral" };
  return (
    <span className={`chip chip-${s.tone}`}>
      <span aria-hidden="true">{s.icon}</span> {s.label}
    </span>
  );
}
