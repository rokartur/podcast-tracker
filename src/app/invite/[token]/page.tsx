import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { invitation, team } from "@/db/schema";
import { AcceptForm } from "./accept-form";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const [row] = await db
    .select({
      email: invitation.email,
      teamName: team.name,
    })
    .from(invitation)
    .innerJoin(team, eq(team.id, invitation.teamId))
    .where(
      and(
        eq(invitation.token, token),
        isNull(invitation.acceptedAt),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .limit(1);

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-800 bg-neutral-900 p-8 shadow-xl">
        {!row ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">
              Invitation inactive
            </h1>
            <p className="mt-3 text-sm leading-6 text-neutral-400">
              This invitation is invalid or has expired. Ask your team
              administrator for a new link.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">
              Join team
            </h1>
            <p className="mt-2 text-sm leading-6 text-neutral-400">
              You&apos;ve been invited to the{" "}
              <span className="font-medium text-neutral-200">
                {row.teamName}
              </span>{" "}
              team. Set up your account below.
            </p>
            <div className="mt-6">
              <AcceptForm
                token={token}
                email={row.email}
                teamName={row.teamName}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
