import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { teamMember } from "@/db/schema";
import { startScan, subscribe, isScanning } from "@/lib/scan-manager";
import type { ScanEvent } from "@/lib/scan-manager";
import { type ScrapePeriod } from "@/lib/channel-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Allow a long-lived SSE connection.
export const maxDuration = 800;

async function resolveTeamId(): Promise<string | null> {
  const sess = await auth.api.getSession({ headers: await headers() });
  if (!sess?.user) return null;
  const membership = await db
    .select({ teamId: teamMember.teamId })
    .from(teamMember)
    .where(eq(teamMember.userId, sess.user.id))
    .orderBy(teamMember.createdAt, teamMember.id)
    .limit(1);
  return membership[0]?.teamId ?? null;
}

function allowedOrigins(): string[] {
  const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const extra =
    process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",")
      .map((o) => o.trim())
      .filter(Boolean) ?? [];
  return [base, ...extra];
}

// Starting a scan is a state change triggered on a GET. Guard it against
// cross-site requests: only start when the Origin/Referer (when present) is
// same-origin. Observing an existing scan stays unrestricted.
function startAllowedFor(req: Request): boolean {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  let candidate: string | null = origin;
  if (!candidate && referer) {
    try {
      candidate = new URL(referer).origin;
    } catch {
      candidate = null;
    }
  }
  if (!candidate) return true; // no Origin/Referer — can't attribute; allow
  try {
    const reqOrigin = new URL(candidate).origin;
    return allowedOrigins().some((o) => {
      try {
        return new URL(o).origin === reqOrigin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * SSE endpoint that OBSERVES a background scan. The actual scan runs detached in
 * the scan manager, so it keeps going even if the client navigates away or the
 * connection drops. Reconnecting replays buffered progress and resumes live.
 *
 * Query params:
 *   period=<ScrapePeriod>  look-back window (default "all")
 *   start=1                start a scan if none is running for this team
 */
export async function GET(req: Request) {
  const teamId = await resolveTeamId();
  if (!teamId) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const period = (url.searchParams.get("period") as ScrapePeriod) ?? "all";
  const wantStart = url.searchParams.get("start") === "1";
  const modeParam = url.searchParams.get("mode");
  const mode =
    modeParam === "backfill"
      ? "backfill"
      : modeParam === "force"
        ? "force"
        : "full";

  if (wantStart && startAllowedFor(req) && !isScanning(teamId)) {
    startScan(teamId, period, mode);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      // Declared before `subscribe()` because its callback can fire
      // synchronously and call cleanup() — referencing these before they're
      // assigned would otherwise hit a temporal-dead-zone ReferenceError.
      // (Assigned once below, but the lexical read-before-assign means it can't
      // be const.)
      // eslint-disable-next-line prefer-const
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void) | null = null;

      const send = (event: ScanEvent | { type: "idle" }) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      unsubscribe = subscribe(teamId, (e) => {
        send(e);
        if (e.type === "finished") {
          cleanup();
        }
      });

      // No scan running/known for this team.
      if (!unsubscribe) {
        send({ type: "idle" });
        controller.close();
        return;
      }

      // Heartbeat keeps proxies from closing an idle connection.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 15_000);

      // Stop streaming when the client disconnects — but the background scan
      // keeps running in the manager.
      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
