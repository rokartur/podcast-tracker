/**
 * Bootstrap the first admin user + team. Run once: `npm run seed`.
 * Idempotent — re-running with the same SEED_ADMIN_EMAIL is a no-op.
 *
 * Creates the credential account by hashing the password with better-auth's
 * own hasher (via auth.$context), so the seeded user can log in normally even
 * though public sign-up is disabled.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { user, account, team, teamMember } from "./schema";
import { auth } from "@/lib/auth";

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "team";
}

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME ?? "Admin";
  const teamName = process.env.SEED_TEAM_NAME ?? "My Podcast Team";

  if (!email || !password) {
    throw new Error("SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set");
  }
  if (password.length < 10) {
    throw new Error("SEED_ADMIN_PASSWORD must be at least 10 characters");
  }

  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  if (existing.length > 0) {
    console.log(`✓ User ${email} already exists — nothing to do.`);
    return;
  }

  const ctx = await auth.$context;
  const passwordHash = await ctx.password.hash(password);

  const userId = crypto.randomUUID();
  const teamId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(user).values({
      id: userId,
      name,
      email,
      emailVerified: true,
      role: "admin",
    });

    await tx.insert(account).values({
      id: crypto.randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: passwordHash,
    });

    await tx.insert(team).values({
      id: teamId,
      name: teamName,
      slug: slugify(teamName) + "-" + teamId.slice(0, 6),
    });

    await tx.insert(teamMember).values({
      id: crypto.randomUUID(),
      teamId,
      userId,
      role: "owner",
    });
  });

  console.log("✓ Seed complete.");
  console.log(`  Admin: ${email}`);
  console.log(`  Team:  ${teamName}`);
  console.log("  Log in at /login");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
