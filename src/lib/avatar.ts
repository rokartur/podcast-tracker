// Derive a guest avatar URL from their social links, with no API key.
//
// unavatar.io resolves a profile picture from a platform + username, e.g.
//   https://unavatar.io/twitter/<handle>
//   https://unavatar.io/youtube/<handle>
// It falls back gracefully, so we only build a URL when we can confidently
// extract a username from a known platform.

function extractHandle(url: string): { platform: string; handle: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const path = u.pathname.replace(/^\/+|\/+$/g, "");

  // X / Twitter: x.com/<handle> or twitter.com/<handle>
  if (host === "x.com" || host === "twitter.com" || host.endsWith(".twitter.com")) {
    const handle = path.split("/")[0];
    if (handle && !["i", "home", "search", "intent"].includes(handle)) {
      return { platform: "twitter", handle: handle.replace(/^@/, "") };
    }
  }

  // YouTube: youtube.com/@handle (channel ids/custom URLs aren't supported by
  // unavatar, so only use the @handle form).
  if (host.includes("youtube.com")) {
    const seg = path.split("/")[0];
    if (seg.startsWith("@")) {
      return { platform: "youtube", handle: seg };
    }
  }

  // Instagram: instagram.com/<user>
  if (host.includes("instagram.com")) {
    const handle = path.split("/")[0];
    if (handle) return { platform: "instagram", handle: handle.replace(/^@/, "") };
  }

  // GitHub: github.com/<user>
  if (host === "github.com") {
    const handle = path.split("/")[0];
    if (handle) return { platform: "github", handle };
  }

  // LinkedIn: linkedin.com/in/<user>
  if (host.includes("linkedin.com")) {
    const parts = path.split("/");
    if (parts[0] === "in" && parts[1]) {
      return { platform: "linkedin", handle: parts[1] };
    }
  }

  return null;
}

// Preferred avatar source order: X/Twitter first, then YouTube, then the rest.
const PLATFORM_ORDER = ["twitter", "youtube", "github", "instagram", "linkedin"];

// Per-platform avatar URL. GitHub serves profile pictures directly and reliably
// (https://github.com/<user>.png) with no rate limit or placeholder, so prefer
// that over unavatar.io; every other platform goes through unavatar.
function platformAvatarUrl(platform: string, handle: string): string {
  const h = encodeURIComponent(handle);
  if (platform === "github") return `https://github.com/${h}.png?size=200`;
  return `https://unavatar.io/${platform}/${h}`;
}

/**
 * Build an ordered list of candidate avatar URLs from a guest's social links —
 * X/Twitter first, then YouTube, then the other platforms. The client tries
 * them in order, falling through to the next when one fails or is rate-limited
 * by unavatar.io. Returns [] when no usable handle is found.
 */
export function avatarCandidates(links: string | null | undefined): string[] {
  if (!links) return [];
  const found = links
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(extractHandle)
    .filter((x): x is { platform: string; handle: string } => x !== null);

  found.sort(
    (a, b) =>
      PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform),
  );

  // De-dupe by platform (one URL per platform) while preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of found) {
    if (seen.has(f.platform)) continue;
    seen.add(f.platform);
    out.push(platformAvatarUrl(f.platform, f.handle));
  }
  return out;
}

/**
 * Single best avatar URL (first candidate) — used where only one value is
 * stored, e.g. the guest's `image` column. Prefers X, then YouTube, then rest.
 * Returns null when no usable handle is found.
 */
export function avatarFromLinks(links: string | null | undefined): string | null {
  return avatarCandidates(links)[0] ?? null;
}
