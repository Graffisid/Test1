import { NextResponse, type NextRequest } from "next/server";
import { getNewApprovals } from "@/lib/queries";
import { isOwner } from "@/lib/session";

export const dynamic = "force-dynamic";

/** New items waiting for the owner since a time (the dashboard polls this to ring the bell). */
export async function GET(req: NextRequest) {
  if (!(await isOwner())) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const since = req.nextUrl.searchParams.get("since") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(since)) return NextResponse.json([]);
  return NextResponse.json(await getNewApprovals(since));
}
