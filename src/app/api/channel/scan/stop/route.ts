import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { teamMember } from "@/db/schema";
import { stopScan } from "@/lib/scan-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Request the current team's background scan to stop after the current batch. */
export async function POST() {
  const sess = await auth.api.getSession({ headers: await headers() });
  if (!sess?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const membership = await db
    .select({ teamId: teamMember.teamId })
    .from(teamMember)
    .where(eq(teamMember.userId, sess.user.id))
    .orderBy(teamMember.createdAt, teamMember.id)
    .limit(1);
  const teamId = membership[0]?.teamId;
  if (!teamId) {
    return NextResponse.json({ error: "No team" }, { status: 403 });
  }

  const stopped = stopScan(teamId);
  return NextResponse.json({ ok: true, stopped });
}
