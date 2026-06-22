import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/db";
import * as schema from "@/db/schema";

export const auth = betterAuth({
  appName: "Podcast Tracker",
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  // Invite-only: public sign-up endpoint is disabled. New accounts are created
  // server-side only after a valid invitation is accepted (see invite actions).
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 10,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh once per day
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  // Rate limit auth endpoints. Enabled in all environments (better-auth only
  // turns it on for production by default) with a strict rule on sign-in to
  // blunt credential stuffing / brute force against the invite-only accounts.
  rateLimit: {
    enabled: true,
    window: 60, // seconds
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
    },
  },
  advanced: {
    cookiePrefix: "podtrack",
    // Secure cookies in production (HTTPS, e.g. behind the cloudflared tunnel).
    useSecureCookies: process.env.NODE_ENV === "production",
  },
  trustedOrigins: [
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    // Extra origins (e.g. a cloudflared tunnel URL), comma-separated.
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",")
      .map((o) => o.trim())
      .filter(Boolean) ?? []),
  ],
  plugins: [admin(), nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
