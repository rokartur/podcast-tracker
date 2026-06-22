import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { teamMember, team } from "@/db/schema";

/**
 * Resolve the current authenticated user + their active team, validated against
 * the DB. Use this in every server component, server action, and route handler
 * that touches team-scoped data — never trust a teamId from the client.
 */
export async function requireMember() {
  const sess = await auth.api.getSession({ headers: await headers() });
  if (!sess?.user) redirect("/login");

  const membership = await db
    .select({
      teamId: teamMember.teamId,
      role: teamMember.role,
      teamName: team.name,
    })
    .from(teamMember)
    .innerJoin(team, eq(team.id, teamMember.teamId))
    .where(eq(teamMember.userId, sess.user.id))
    // Deterministic: a user in >1 team always resolves to the same (earliest)
    // membership instead of an arbitrary row.
    .orderBy(teamMember.createdAt, teamMember.id)
    .limit(1);

  if (membership.length === 0) {
    // Authenticated but assigned to no team — dead end, sign-out path.
    redirect("/login?error=no-team");
  }

  return {
    user: sess.user,
    teamId: membership[0].teamId,
    teamName: membership[0].teamName,
    role: membership[0].role,
  };
}

export async function getOptionalSession() {
  return auth.api.getSession({ headers: await headers() });
}
