import "server-only";
import { safeFetchTextSafe } from "@/lib/net";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 8000;

// A pre-consent cookie so YouTube serves the real channel page instead of the
// EU "Before you continue" consent interstitial (which carries no channel data).
const YT_CONSENT_COOKIE =
  "SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwMTI0LjA2X3AwGgJlbiACGgYIgL2vrwY";

// URLs come from LLM/scrape output → SSRF-guarded fetch (public-host only).
async function fetchTextSafe(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<string> {
  return safeFetchTextSafe(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en", ...extraHeaders },
    timeoutMs: TIMEOUT_MS,
  });
}

// Turn a human count like "1.2M", "12.3K", "1,234" or "987" into a number.
export function parseCompact(raw: string): number | null {
  const m = raw.replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult =
    m[2]?.toUpperCase() === "B"
      ? 1e9
      : m[2]?.toUpperCase() === "M"
        ? 1e6
        : m[2]?.toUpperCase() === "K"
          ? 1e3
          : 1;
  return Math.round(n * mult);
}

// Match on the URL's HOST, not a substring — otherwise an internal target like
// "http://169.254.169.254/#youtube.com" would be treated as a YouTube URL and
// fetched. (The fetch is also SSRF-guarded, but this avoids even trying.)
function hostMatches(url: string, suffixes: string[]): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return suffixes.some((s) => host === s || host.endsWith("." + s));
  } catch {
    return false;
  }
}

export function isYoutube(url: string): boolean {
  return hostMatches(url, ["youtube.com", "youtu.be"]);
}

export function isX(url: string): boolean {
  return hostMatches(url, ["twitter.com", "x.com"]);
}

function youtubeHandle(url: string): string | null {
  const m = url.match(/@([A-Za-z0-9._-]+)/);
  return m ? m[1] : null;
}

/**
 * YouTube subscriber count for a channel URL — the channel's OWN count, as shown
 * in its page header (e.g. "21M subscribers"). YouTube only publishes an
 * abbreviated value, so that's what we return.
 *
 * Accuracy notes: the page also embeds `subscriberCountText` for every channel in
 * the "Channels" / recommendation shelves, so naively grabbing the first
 * "N subscribers" yields a DIFFERENT channel's count. The channel's own number
 * lives in the page-header view model, which uses one of two layouts:
 *   A) "metadataParts":[{"text":{"content":"21M subscribers"} ...   (most channels)
 *   B) "subtitle":{"content":"…@handle⁩ • ⁨21M subscribers⁩"}        (some channels)
 * We match those header-specific shapes only — never the recommendation shelves.
 */
export async function fetchYoutubeSubscribers(
  url: string,
): Promise<number | null> {
  const html = await fetchTextSafe(url, { Cookie: YT_CONSENT_COOKIE });
  if (!html) return null;

  // Layout A — page-header metadata row (the very first metadataParts entry).
  let m = html.match(
    /"metadataParts":\[\{"text":\{"content":"([\d.,]+\s*[KMB]?)\s+subscribers"/,
  );

  // Layout B — header subtitle anchored to this channel's @handle, so we never
  // pick up a collaborator's or recommended channel's count.
  if (!m) {
    const handle = youtubeHandle(url);
    if (handle) {
      const safe = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      m = html.match(
        new RegExp(`@${safe}[^"]*?([\\d.,]+\\s*[KMB]?)\\s+subscribers`, "i"),
      );
    }
  }

  return m ? parseCompact(m[1]) : null;
}

/**
 * Best-effort X/Twitter follower count. X aggressively blocks scraping, so this
 * usually returns null — it only succeeds when a follower count happens to be
 * present in the served HTML/metadata. Never throws.
 */
export async function fetchXFollowers(url: string): Promise<number | null> {
  const html = await fetchTextSafe(url);
  if (!html) return null;
  const m =
    html.match(/([\d.,]+[KMB]?)\s+Followers/i) ??
    html.match(/"followers_count":\s*(\d+)/);
  if (!m) return null;
  return parseCompact(m[1]);
}

export type Reach = {
  youtubeSubscribers: number | null;
  xFollowers: number | null;
};

/**
 * Given a guest's links, pull the first YouTube subscriber count and X follower
 * count we can find. Both are best-effort and independent; either may be null.
 */
export async function fetchReachFromLinks(
  links: (string | null | undefined)[],
): Promise<Reach> {
  const urls = [...new Set(links.map((l) => l?.trim()).filter(Boolean) as string[])];
  const yt = urls.find(isYoutube);
  const x = urls.find(isX);
  const [youtubeSubscribers, xFollowers] = await Promise.all([
    yt ? fetchYoutubeSubscribers(yt) : Promise.resolve(null),
    x ? fetchXFollowers(x) : Promise.resolve(null),
  ]);
  return { youtubeSubscribers, xFollowers };
}
