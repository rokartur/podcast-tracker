import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { channel } from "@/db/schema";
import { scrapeChannelForTeam } from "@/lib/channel-scrape-core";

// Process at most this many channels concurrently so a many-team deployment
// doesn't fan out hundreds of simultaneous scrapes from one tick.
const CONCURRENCY = 3;

export type DueScanResult = {
  teamId: string;
  ran: boolean;
  newVideos?: number;
  newGuests?: number;
  error?: string;
};

export type RunDueScansResult = {
  hour: number;
  date: string;
  processed: number;
  results: DueScanResult[];
};

/**
 * Run the daily auto-scan for every channel that is due right now.
 *
 * Shared by the HTTP cron endpoint (`/api/cron/scrape`) and the in-app
 * scheduler (`lib/cron/scheduler`), so both behave identically. A channel is
 * "due" when auto-scan is enabled, its `scheduleHour` equals the current server
 * hour and it has not already run today — unless `force` is set, which ignores
 * the hour/once-a-day guards (still limited to enabled channels).
 *
 * `lastAutoRunDate` is stamped (server-local date) after each channel so it
 * never fires twice in one day and a repeated tick within the same hour is a
 * no-op.
 */
export async function runDueScans({
  force = false,
  now = new Date(),
}: { force?: boolean; now?: Date } = {}): Promise<RunDueScansResult> {
  const currentHour = now.getHours();
  // Local calendar date, kept consistent with getHours() above so the
  // once-a-day guard rolls over at the server's local midnight (matches the
  // "server local time" meaning of scheduleHour).
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const channels = await db
    .select()
    .from(channel)
    .where(eq(channel.scheduleEnabled, true));

  const due = channels.filter((ch) => {
    const dueByHour = force || ch.scheduleHour === currentHour;
    const alreadyRanToday = ch.lastAutoRunDate === today;
    return dueByHour && !(alreadyRanToday && !force);
  });

  const results: DueScanResult[] = channels
    .filter((ch) => !due.includes(ch))
    .map((ch) => ({ teamId: ch.teamId, ran: false }));

  // Bounded-concurrency worker pool over the due channels.
  let cursor = 0;
  async function worker() {
    while (cursor < due.length) {
      const ch = due[cursor++];
      let res;
      try {
        res = await scrapeChannelForTeam(ch.teamId, "all");
      } catch (e) {
        res = {
          ok: false as const,
          error: e instanceof Error ? e.message : "Scan failed",
        };
      }
      // Mark today as run regardless of outcome so a failing channel doesn't
      // get retried every hour all day.
      await db
        .update(channel)
        .set({ lastAutoRunDate: today })
        .where(eq(channel.id, ch.id));

      results.push(
        res.ok
          ? {
              teamId: ch.teamId,
              ran: true,
              newVideos: res.newVideos,
              newGuests: res.newGuests,
            }
          : { teamId: ch.teamId, ran: true, error: res.error },
      );
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, due.length) }, () => worker()),
  );

  return {
    hour: currentHour,
    date: today,
    processed: results.filter((r) => r.ran).length,
    results,
  };
}
