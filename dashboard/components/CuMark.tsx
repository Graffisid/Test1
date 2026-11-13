/** A credit union's monogram in its ONCU colour (an SVG fill, so the strict CSP needs no inline style). Not an official logo. */
export function CuMark({ name, color, size = 34 }: { name: string; color: string | null; size?: number }) {
  const mono = name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "CU";
  return (
    <svg className="cu-mark" width={size} height={size} viewBox="0 0 34 34" aria-hidden="true">
      <rect width="34" height="34" rx="10" fill={color ?? "#0e7c86"} />
      <text x="17" y="21.5" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff">{mono}</text>
    </svg>
  );
}
