import { NextResponse, type NextRequest } from "next/server";
import { AGENTS, getActivity } from "@/lib/queries";
import { isOwner } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isOwner())) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const agentParam = req.nextUrl.searchParams.get("agent");
  const agent = agentParam && (AGENTS as readonly string[]).includes(agentParam) ? agentParam : null;
  const flaggedOnly = req.nextUrl.searchParams.get("flagged") === "1";
  const rows = await getActivity({ agent, flaggedOnly, limit: 50 });
  return NextResponse.json(rows);
}
