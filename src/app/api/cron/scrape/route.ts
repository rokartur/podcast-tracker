import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { runDueScans } from "@/lib/cron/run-due-scans";

export const runtime = "nodejs";
// Never cache — this must run fresh every invocation.
export const dynamic = "force-dynamic";
// A full back-catalogue scan can take minutes; don't let the platform abort it.
export const maxDuration = 800;

/**
 * Daily scan cron endpoint.
 *
 * Intended to be hit once per hour by an external scheduler (system cron,
 * GitHub Actions, etc.). The actual work — finding every channel that is due
 * and scanning it — lives in `runDueScans`, shared with the in-app scheduler
 * (lib/cron/scheduler) so both paths behave identically.
 *
 * Protected by a bearer token in the `CRON_SECRET` env var. Send it ONLY as
 *   Authorization: Bearer <CRON_SECRET>
 * (the secret is never accepted in the query string, which would leak it into
 * access/proxy logs and browser history).
 */
function secretMatches(provided: string, expected: string): boolean {
  // Hash both sides to a fixed 32-byte digest so timingSafeEqual never sees
  // unequal lengths (which would throw and also leak length via timing).
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured" },
      { status: 500 },
    );
  }

  const provided = req.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");
  if (!provided || !secretMatches(provided, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // `force=1` ignores the hour/already-ran-today guards (manual trigger/testing).
  // Still limited to channels with auto-scan enabled.
  const force = new URL(req.url).searchParams.get("force") === "1";

  const result = await runDueScans({ force });
  return NextResponse.json({ ok: true, ...result });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
