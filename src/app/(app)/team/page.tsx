import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { invitation, teamMember, user } from "@/db/schema";
import { requireMember } from "@/lib/session";
import { TeamManager } from "./team-manager";

export default async function TeamPage() {
  const { teamId, role } = await requireMember();

  // Only owners and admins may manage the team. Members get bounced.
  if (role !== "owner" && role !== "admin") {
    redirect("/guests");
  }

  const members = await db
    .select({
      id: teamMember.id,
      role: teamMember.role,
      name: user.name,
      email: user.email,
    })
    .from(teamMember)
    .innerJoin(user, eq(user.id, teamMember.userId))
    .where(eq(teamMember.teamId, teamId))
    .orderBy(desc(teamMember.createdAt));

  const pending = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      token: invitation.token,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .where(
      and(
        eq(invitation.teamId, teamId),
        isNull(invitation.acceptedAt),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(invitation.createdAt));

  return (
    <div className="w-full max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-white">Team</h1>
        <p className="text-sm text-white/40">
          Invite people to the team and manage who has access.
        </p>
      </header>

      <TeamManager
        canInviteAdmins={role === "owner"}
        members={members}
        pending={pending.map((p) => ({
          ...p,
          expiresAt: p.expiresAt.toISOString(),
        }))}
      />
    </div>
  );
}
