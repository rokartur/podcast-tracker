// Shared helpers for assembling guest records from AI output + scraped text.
import { safeWebUrl } from "@/lib/url-safety";
import { isPublicUrl } from "@/lib/net";

// De-duplicate topics case-insensitively while preserving the first-seen
// casing/order. Returns a clean comma-separated string (or "" if none).
export function dedupeTopics(topics: (string | undefined | null)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of topics) {
    const t = raw?.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.join(", ");
}

// Build a newline-separated link list from a set of candidate URLs, dropping
// blanks and de-duplicating (case-insensitive). Only http(s) URLs are kept:
// these values come from LLM/scraped output and are later rendered as `href`,
// so anything with a script-bearing scheme (javascript:, data:, …) must never
// be stored. Each kept URL is also length-capped.
export function buildLinks(urls: (string | undefined | null)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const u = safeWebUrl(raw);
    if (!u || u.length > 2048) continue;
    const key = u.toLowerCase().replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out.join("\n");
}

// Probe one URL and report whether it's worth keeping. We only drop links that
// are *confirmed* dead (404 Not Found / 410 Gone) — everything else (2xx/3xx,
// auth walls, rate limits, network errors, timeouts) is kept, since a transient
// failure shouldn't silently delete a real link. Tries HEAD first, falling back
// to GET when a server rejects HEAD (405/501).
async function isLinkReachable(url: string): Promise<boolean> {
  // SSRF guard: never probe a URL whose host resolves to a private/loopback/
  // link-local address. Such a link is dropped from the stored list entirely.
  if (!(await isPublicUrl(url))) return false;
  const dead = (status: number) => status === 404 || status === 410;
  const probe = async (method: "HEAD" | "GET") => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      return await fetch(url, {
        method,
        redirect: "follow",
        signal: ctrl.signal,
        headers: { "user-agent": "Mozilla/5.0 (podcast-tracker link check)" },
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res = await probe("HEAD");
    if (res.status === 405 || res.status === 501) res = await probe("GET");
    return !dead(res.status);
  } catch {
    // Network error / timeout / bad URL — keep it, can't prove it's dead.
    return true;
  }
}

// Filter a newline-separated link list down to links that aren't confirmed dead.
// Probes run in parallel. Returns a newline-separated string (or "" if none).
export async function filterReachableLinks(
  links: string | null | undefined,
): Promise<string> {
  const list = (links ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (list.length === 0) return "";
  const results = await Promise.all(
    list.map(async (l) => ((await isLinkReachable(l)) ? l : null)),
  );
  return results.filter((l): l is string => l !== null).join("\n");
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// File/code extensions that the email regex mistakes for a TLD. Minified
// bundles and asset URLs in scraped HTML produce strings like
// "fe@ures-cnrrqvbo.js" or "img@2x.png" that match EMAIL_RE but are not
// addresses. Reject any "email" whose TLD is one of these.
const FAKE_TLDS = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "sass", "less",
  "json", "html", "htm", "xml", "svg", "ico", "map", "wasm", "php", "asp",
  "aspx", "py", "rb", "go", "java", "sh", "yml", "yaml", "toml", "lock",
  "md", "txt", "csv", "pdf", "zip", "gz", "tar",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tiff",
  "woff", "woff2", "ttf", "eot", "otf",
  "mp4", "webm", "mov", "mp3", "wav", "ogg",
]);

// True when the address' TLD is actually a file/code extension (not a domain).
function hasFakeTld(email: string): boolean {
  const tld = email.split(".").pop()?.toLowerCase() ?? "";
  return FAKE_TLDS.has(tld);
}

// Pull the most likely public contact email out of free text (e.g. a YouTube
// video description, which creators often use for "business@..." contacts).
// Skips obvious noise (image/asset filenames, no-reply addresses). Prefers
// addresses near contact keywords. Returns null when nothing usable is found.
export function extractEmailFromText(...texts: (string | null | undefined)[]): string | null {
  const blob = texts.filter(Boolean).join("\n");
  if (!blob) return null;

  const matches = blob.match(EMAIL_RE) ?? [];
  const candidates = matches
    .map((m) => m.trim().toLowerCase())
    .filter(
      (m) =>
        !hasFakeTld(m) &&
        !/(no-?reply|noreply|example\.com|sentry|wixpress)/.test(m),
    );
  if (candidates.length === 0) return null;

  // Prefer an address mentioned near a contact keyword.
  const lower = blob.toLowerCase();
  const preferred = candidates.find((m) => {
    const i = lower.indexOf(m);
    if (i < 0) return false;
    const around = lower.slice(Math.max(0, i - 60), i);
    return /(business|contact|inquir|booking|press|reach|e-?mail|collab|sponsor)/.test(
      around,
    );
  });

  return preferred ?? candidates[0];
}

// Validate that a string looks like a real email address.
export function isEmail(v: string | null | undefined): boolean {
  const e = v?.trim().toLowerCase();
  return !!e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !hasFakeTld(e);
}
