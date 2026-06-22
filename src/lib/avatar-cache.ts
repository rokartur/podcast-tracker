import "server-only";
import { createHash } from "node:crypto";
import { avatarCandidates } from "@/lib/avatar";

// Server-side avatar fetching + caching helpers. The browser hammering a single
// rate-limited host is the root cause of blank avatars; fetching once from the
// server and storing the bytes in the DB makes them permanently available.

const FETCH_TIMEOUT_MS = 8_000;
// Cap stored avatars so a hostile/huge response can't bloat the DB or memory.
const MAX_BYTES = 2_000_000;

export type FetchedAvatar = { data: Buffer; type: string };

// unavatar serves its own generic placeholder when it can't resolve a real
// profile picture. We'd rather fall back to our own initials avatar than cache
// that placeholder forever, so force a 404 on a miss with `fallback=false`.
function withNoFallback(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("unavatar.io")) u.searchParams.set("fallback", "false");
    return u.toString();
  } catch {
    return url;
  }
}

async function tryFetch(url: string): Promise<FetchedAvatar | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(withNoFallback(url), {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "podcast-tracker-avatar/1.0" },
    });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;
    return { data: buf, type };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Avatar sources keyed off the guest's email: Gravatar (MD5 hash of the
// lowercased address) and unavatar's email lookup (which also resolves Google
// profile photos). Many guests have a contact email but no usable social
// handle, so this is often the only real photo available. `d=404` forces
// Gravatar to 404 on a miss so we fall through to initials instead of caching
// its generic mystery-person icon.
function emailCandidates(email: string | null): string[] {
  const e = email?.trim().toLowerCase();
  if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return [];
  const hash = createHash("md5").update(e).digest("hex");
  return [
    `https://gravatar.com/avatar/${hash}?s=200&d=404`,
    `https://unavatar.io/${encodeURIComponent(e)}`,
  ];
}

/**
 * Fetch the best available avatar for a guest, trying the stored image URL, then
 * each social-derived candidate, then email-derived sources (Gravatar/Google),
 * in order. Returns null when none resolve to a real image (caller should fall
 * back to an initials avatar).
 */
export async function fetchAvatar(
  image: string | null,
  links: string | null,
  email: string | null = null,
): Promise<FetchedAvatar | null> {
  const candidates = [
    ...new Set(
      [image, ...avatarCandidates(links), ...emailCandidates(email)].filter(
        Boolean,
      ) as string[],
    ),
  ];
  for (const url of candidates) {
    const got = await tryFetch(url);
    if (got) return got;
  }
  return null;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/**
 * Deterministic initials avatar as an SVG string — the ultimate fallback so a
 * guest is never rendered with a blank circle. Background hue is derived from
 * the name so the same person always gets the same colour.
 */
export function initialsSvg(name: string): string {
  const initials =
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72"><rect width="72" height="72" fill="hsl(${hue} 45% 30%)"/><text x="50%" y="52%" fill="rgba(255,255,255,0.85)" font-family="system-ui,-apple-system,sans-serif" font-size="30" font-weight="600" text-anchor="middle" dominant-baseline="middle">${escapeXml(initials)}</text></svg>`;
}
