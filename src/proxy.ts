import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Next.js 16 renamed the `middleware` convention to `proxy`.
// Lightweight gate: redirect unauthenticated users away from app routes.
// This is an optimistic cookie-presence check only — every server action and
// route handler still re-validates the session against the DB (see lib/session).
// `/api/cron` is protected by its own CRON_SECRET bearer token, not a session.
const PUBLIC_PREFIXES = ["/login", "/invite", "/api/auth", "/api/cron"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const sessionCookie = getSessionCookie(request, {
    cookiePrefix: "podtrack",
  });

  if (!sessionCookie) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything except static assets and Next internals.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico)).*)",
  ],
};
