/** Number formatting shared by the story engine, pages and charts (safe for client components). */
const LABEL: Record<string, string> = {
  assets: "Assets", netIncome: "Net income", deposits: "Deposits", loans: "Loans", costIncome: "Cost-to-income",
  loanDepositRatio: "Loans to deposits", niiAssets: "Net interest income to assets", riskCapital: "Risk-weighted capital",
  equityAssets: "Equity to assets", assetGrowth: "Asset growth", loanGrowth: "Loan growth", depositGrowth: "Deposit growth",
  allowanceRatio: "Loan allowance to loans", roaa: "Return on average assets", members: "Members",
};
export const PERCENT = new Set(["costIncome", "loanDepositRatio", "niiAssets", "riskCapital", "equityAssets", "assetGrowth", "loanGrowth",
  "depositGrowth", "allowanceRatio", "roaa"]);

export function money(v: number): string {
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${Math.round(a / 1e3).toLocaleString("en-CA")}K`;
  return `${s}$${Math.round(a).toLocaleString("en-CA")}`;
}
export const pct = (v: number, d = 1) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%`;
export const display = (metric: string, v: number) =>
  PERCENT.has(metric) ? pct(v, metric === "niiAssets" || metric === "allowanceRatio" || metric === "roaa" ? 2 : 1)
    : metric === "members" ? Math.round(v).toLocaleString("en-CA") : money(v);
export const label = (metric: string) => LABEL[metric] ?? metric;
