// Configuration + shared types for the dedicated channel scraper.
// Kept separate from the "use server" action module, which may only export
// async functions.

// The channel this scraper is tailored to. Hard-coded by design: this is a
// dedicated scraper for David Ondrej's AI channel, not a generic one.
export const DAVID_ONDREJ_HANDLE = "@DavidOndrej";

// Extra playlists to scan alongside the channel's uploads. Videos are merged
// and de-duplicated by videoId, so a video that is both an upload and in a
// playlist is only remembered once.
export const DAVID_ONDREJ_PLAYLISTS: string[] = [
  "PL2xnrU4RbY0AamUB7lEm8-ZJsq0yzELRz",
];

// How far back to look when remembering videos. The channel RSS feed only
// carries the latest ~15 uploads, so a period acts as an upper bound on those.
export type ScrapePeriod = "7d" | "30d" | "90d" | "365d" | "all";

export const SCRAPE_PERIODS: { value: ScrapePeriod; label: string; days: number | null }[] = [
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
  { value: "365d", label: "Last 12 months", days: 365 },
  { value: "all", label: "All available", days: null },
];

export function periodDays(period: ScrapePeriod): number | null {
  return SCRAPE_PERIODS.find((p) => p.value === period)?.days ?? null;
}

export type ScrapeChannelResult =
  | {
      ok: true;
      newVideos: number;
      newGuests: number;
      guestNames: string[];
      totalVideosSeen: number;
    }
  | { ok: false; error: string };
