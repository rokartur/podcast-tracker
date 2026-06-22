/**
 * Create (or promote) a login-capable admin user from the CLI.
 *
 * Unlike `seed.ts` (one-time bootstrap via env vars), this is a repeatable
 * tool for adding admins on demand even though public sign-up is disabled.
 *
 *   npm run create-admin -- --email you@example.com --name "Jane" --password "supersecret10"
 *   npm run create-admin -- --email you@example.com            # prompts for password
 *   npm run create-admin -- --email you@example.com --team "My Podcast Team"
 *
 * Flags:
 *   --email     <email>   required
 *   --password  <pw>      optional; if omitted you are prompted (hidden input)
 *   --name      <name>    optional (default: derived from email)
 *   --team      <name>    optional; join existing team by name, else create it
 *                         (default: first existing team, or "My Podcast Team")
 *   --role      <r>       team role: owner | admin | member (default: owner)
 *
 * Behaviour:
 *   - New email      -> creates user (global role "admin") + credential account.
 *   - Existing email -> promotes to admin and resets the password.
 *   - Always ensures the user is a member of the chosen team.
 *
 * Credentials are hashed with better-auth's own hasher (via auth.$context), so
 * the account can log in normally at /login.
 */
import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { createInterface } from "node:readline";
import { db } from "./index";
import { user, account, team, teamMember } from "./schema";
import { auth } from "@/lib/auth";

type MemberRole = "owner" | "admin" | "member";

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "team"
  );
}

/** Prompt for a password with the terminal echo turned off. */
function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;
    // Mute echoed characters.
    const onData = (char: Buffer) => {
      const s = char.toString();
      if (s === "\n" || s === "\r" || s === "\u0004") return;
      // Re-print the prompt without the typed characters.
      process.stdout.write("\r\x1b[2K" + question);
    };
    process.stdout.write(question);
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.on("data", onData);
    }
    rl.question("", (answer) => {
      if (stdin.isTTY) stdin.removeListener("data", onData);
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw);
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

async function resolveTeamId(teamName: string | undefined): Promise<string> {
  // 1) Explicit team name: join if it exists, otherwise create it.
  if (teamName) {
    const [existing] = await db
      .select({ id: team.id })
      .from(team)
      .where(eq(team.name, teamName))
      .limit(1);
    if (existing) return existing.id;

    const teamId = crypto.randomUUID();
    await db.insert(team).values({
      id: teamId,
      name: teamName,
      slug: slugify(teamName) + "-" + teamId.slice(0, 6),
    });
    console.log(`  Created team "${teamName}".`);
    return teamId;
  }

  // 2) No name given: reuse the first existing team if any.
  const [first] = await db.select({ id: team.id }).from(team).limit(1);
  if (first) return first.id;

  // 3) Nothing exists yet: create a default team.
  const defaultName = "My Podcast Team";
  const teamId = crypto.randomUUID();
  await db.insert(team).values({
    id: teamId,
    name: defaultName,
    slug: slugify(defaultName) + "-" + teamId.slice(0, 6),
  });
  console.log(`  Created default team "${defaultName}".`);
  return teamId;
}

async function ensureTeamMembership(
  teamId: string,
  userId: string,
  role: MemberRole,
) {
  const [existing] = await db
    .select({ id: teamMember.id })
    .from(teamMember)
    .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, userId)))
    .limit(1);

  if (existing) {
    await db
      .update(teamMember)
      .set({ role })
      .where(eq(teamMember.id, existing.id));
    return;
  }

  await db.insert(teamMember).values({
    id: crypto.randomUUID(),
    teamId,
    userId,
    role,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const email = (args.email ?? process.env.ADMIN_EMAIL ?? "").trim();
  if (!email || !email.includes("@")) {
    throw new Error("A valid --email is required");
  }

  const name =
    args.name ?? process.env.ADMIN_NAME ?? email.split("@")[0] ?? "Admin";

  const teamRole = (args.role ?? "owner") as MemberRole;
  if (!["owner", "admin", "member"].includes(teamRole)) {
    throw new Error(`Invalid --role "${teamRole}" (owner | admin | member)`);
  }

  let password = args.password ?? process.env.ADMIN_PASSWORD ?? "";
  if (!password) {
    password = await promptPassword("Password (min 10 chars): ");
  }
  if (password.length < 10) {
    throw new Error("Password must be at least 10 characters");
  }

  const ctx = await auth.$context;
  const passwordHash = await ctx.password.hash(password);

  const teamId = await resolveTeamId(args.team);

  const [existingUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  if (existingUser) {
    // Promote to admin and reset the credential password.
    const userId = existingUser.id;
    await db
      .update(user)
      .set({ role: "admin", emailVerified: true, updatedAt: new Date() })
      .where(eq(user.id, userId));

    const [cred] = await db
      .select({ id: account.id })
      .from(account)
      .where(
        and(eq(account.userId, userId), eq(account.providerId, "credential")),
      )
      .limit(1);

    if (cred) {
      await db
        .update(account)
        .set({ password: passwordHash, updatedAt: new Date() })
        .where(eq(account.id, cred.id));
    } else {
      await db.insert(account).values({
        id: crypto.randomUUID(),
        accountId: userId,
        providerId: "credential",
        userId,
        password: passwordHash,
      });
    }

    await ensureTeamMembership(teamId, userId, teamRole);

    console.log("✓ Existing user promoted to admin & password reset.");
    console.log(`  Admin: ${email}`);
    console.log("  Log in at /login");
    return;
  }

  // Fresh user: create user + credential account + team membership atomically.
  const userId = crypto.randomUUID();
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

    await tx.insert(teamMember).values({
      id: crypto.randomUUID(),
      teamId,
      userId,
      role: teamRole,
    });
  });

  console.log("✓ Admin account created.");
  console.log(`  Admin: ${email}`);
  console.log(`  Name:  ${name}`);
  console.log("  Log in at /login");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("create-admin failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
