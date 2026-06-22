"use server";

import { z } from "zod";
import { and, eq, gt, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { invitation, teamMember, user } from "@/db/schema";
import { auth } from "@/lib/auth";
import { requireMember } from "@/lib/session";

const acceptSchema = z.object({
  token: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(10).max(200),
});

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  // NOTE: "owner" is intentionally NOT accepted — owner is never granted via an
  // invite. The TS type is compile-time only; this runtime allowlist is the
  // actual trust boundary.
  role: z.enum(["admin", "member"]).optional(),
});

export async function acceptInvite(input: {
  token: string;
  name: string;
  password: string;
}) {
  const parsed = acceptSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Please provide a valid name and a password of 10+ characters");
  }
  const { token, name, password } = parsed.data;

  // Atomically claim the invite: a conditional UPDATE means only one concurrent
  // request can win, closing the check-then-act race. We claim BEFORE creating
  // the account and roll the claim back if account creation fails, so a
  // transient error doesn't permanently burn a valid invite.
  const [claimed] = await db
    .update(invitation)
    .set({ acceptedAt: new Date() })
    .where(
      and(
        eq(invitation.token, token),
        isNull(invitation.acceptedAt),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .returning();

  if (!claimed) {
    throw new Error("This invitation is invalid or has expired");
  }

  let createdUserId: string | null = null;
  try {
    // Create the account server-side via the admin plugin (public sign-up is
    // off). Email is taken from the invitation, never from the client.
    const created = await auth.api.createUser({
      body: {
        email: claimed.email,
        password,
        name,
        role: "user",
      },
    });
    createdUserId = created.user.id;

    await db.insert(teamMember).values({
      id: crypto.randomUUID(),
      teamId: claimed.teamId,
      userId: createdUserId,
      role: claimed.role,
    });
  } catch {
    // Release the claim so the invite can be retried. Generic error — never
    // surface whether the email already exists (account enumeration).
    await db
      .update(invitation)
      .set({ acceptedAt: null })
      .where(eq(invitation.id, claimed.id));
    // If the account was created but linking it to the team failed, remove the
    // orphaned user so a retry can recreate it (otherwise the email-unique
    // constraint would soft-burn the invite). createUser only succeeds for a
    // brand-new email, so this never deletes a pre-existing account.
    if (createdUserId) {
      await db.delete(user).where(eq(user.id, createdUserId)).catch(() => {});
    }
    throw new Error("Could not complete sign-up. Please try again.");
  }
}

export async function createInvite(input: {
  email: string;
  role?: "admin" | "member";
}) {
  const { user, teamId, role } = await requireMember();

  if (role !== "owner" && role !== "admin") {
    throw new Error("You don't have permission to invite members");
  }

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Enter a valid email address");
  }
  const requestedRole = parsed.data.role ?? "member";

  // Least privilege: only an owner may grant the admin role. Admins can invite
  // members only. (createSchema already forbids granting "owner".)
  if (requestedRole === "admin" && role !== "owner") {
    throw new Error("Only an owner can invite admins");
  }

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.insert(invitation).values({
    id: crypto.randomUUID(),
    teamId,
    email: parsed.data.email,
    role: requestedRole,
    token,
    invitedBy: user.id,
    expiresAt,
  });

  revalidatePath("/team");
  return { token };
}

export async function revokeInvite(input: { id: string }) {
  const { teamId, role } = await requireMember();

  if (role !== "owner" && role !== "admin") {
    throw new Error("You don't have permission to manage invites");
  }

  const parsed = z.object({ id: z.string().min(1).max(100) }).safeParse(input);
  if (!parsed.success) {
    throw new Error("Invalid invitation");
  }

  // Scope the delete to the caller's team so an admin can't revoke another
  // team's invite by guessing an id. Only un-accepted invites can be revoked.
  await db
    .delete(invitation)
    .where(
      and(
        eq(invitation.id, parsed.data.id),
        eq(invitation.teamId, teamId),
        isNull(invitation.acceptedAt),
      ),
    );

  revalidatePath("/team");
}
