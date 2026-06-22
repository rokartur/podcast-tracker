import "server-only";
import { runDueScans } from "@/lib/cron/run-due-scans";

// How often to check whether any channel is due. The actual scan still runs at
// most once a day per channel (guarded by scheduleHour + lastAutoRunDate), so a
// sub-hour tick is just there to reliably catch the scheduled hour even when the
// server boots part-way through it.
const TICK_MS = 15 * 60 * 1000;
// Small delay after boot before the first check, so startup isn't blocked and a
// just-deployed server settles before doing any scraping.
const FIRST_TICK_MS = 30 * 1000;

// Survive dev hot-reloads / repeated register() calls: a single interval per
// process, tracked on globalThis so a reload clears the old one first.
const g = globalThis as unknown as {
  __podcastCron?: { timer?: ReturnType<typeof setInterval>; running: boolean };
};

function enabled(): boolean {
  // On by default; opt out with CRON_IN_APP=0/false (e.g. when an external
  // crontab already calls /api/cron/scrape and you don't want both).
  const v = process.env.CRON_IN_APP?.toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

async function tick() {
  const state = g.__podcastCron;
  // Never overlap ticks — a long back-catalogue scan can outlast TICK_MS.
  if (!state || state.running) return;
  state.running = true;
  try {
    const res = await runDueScans();
    if (res.processed > 0) {
      console.log(
        `[cron] ran ${res.processed} channel scan(s) at hour ${res.hour} (${res.date})`,
      );
    }
  } catch (e) {
    console.error("[cron] tick failed:", e);
  } finally {
    state.running = false;
  }
}

export function startScheduler() {
  if (!enabled()) {
    console.log("[cron] in-app scheduler disabled (CRON_IN_APP)");
    return;
  }
  // Clear any interval left over from a previous reload.
  if (g.__podcastCron?.timer) clearInterval(g.__podcastCron.timer);

  g.__podcastCron = { running: false };
  const timer = setInterval(() => void tick(), TICK_MS);
  // Don't keep the event loop alive just for this timer.
  timer.unref?.();
  g.__podcastCron.timer = timer;

  // First check shortly after boot (also unref'd via setTimeout).
  setTimeout(() => void tick(), FIRST_TICK_MS).unref?.();

  console.log(`[cron] in-app scheduler started (every ${TICK_MS / 60000} min)`);
}
