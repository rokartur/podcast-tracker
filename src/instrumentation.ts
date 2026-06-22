// Runs once when a Next.js server instance starts (dev `next dev` and prod
// `next start` alike). We use it to launch the in-app daily auto-scan scheduler.
// Only the Node.js runtime can talk to Postgres / drive the scraper, so guard on
// NEXT_RUNTIME and dynamically import so the Edge runtime never loads server-only
// code.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startScheduler } = await import("@/lib/cron/scheduler");
  startScheduler();
}
