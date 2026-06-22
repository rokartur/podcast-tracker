import "server-only";
import { extractEmailFromText, isEmail } from "@/lib/guest-utils";
import { safeFetchTextSafe } from "@/lib/net";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 8000;

// Targets here derive from LLM/scrape output, so every fetch is SSRF-guarded
// (public-host only, manual redirect re-validation, byte cap) via net.ts.
async function fetchTextSafe(
  url: string,
  headers: Record<string, string> = {},
): Promise<string> {
  return safeFetchTextSafe(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en", ...headers },
    timeoutMs: TIMEOUT_MS,
  });
}

// Pull emails out of explicit `mailto:` links — the most reliable signal on a
// page, since it's a deliberate contact link rather than incidental text.
function mailtoEmails(html: string): string[] {
  const out: string[] = [];
  const re = /mailto:([^"'?>\s]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const e = decodeURIComponent(m[1]).trim().toLowerCase();
    if (isEmail(e)) out.push(e);
  }
  return out;
}

// Decode Cloudflare's email obfuscation (data-cfemail="<hex>"), a common way
// sites hide addresses from naive scrapers. First hex byte is the XOR key.
function cloudflareEmails(html: string): string[] {
  const out: string[] = [];
  const re = /data-cfemail="([0-9a-f]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const hex = m[1];
    const key = parseInt(hex.slice(0, 2), 16);
    let decoded = "";
    for (let i = 2; i < hex.length; i += 2) {
      decoded += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    }
    const e = decoded.trim().toLowerCase();
    if (isEmail(e)) out.push(e);
  }
  return out;
}

// Reverse common text obfuscation like "name [at] domain [dot] com" or
// "name (at) domain dot com" into "name@domain.com", then extract.
function deobfuscatedEmail(html: string): string | null {
  const normalized = html
    .replace(/\s*[\[(]?\s*(?:at|@)\s*[\])]?\s*/gi, "@")
    .replace(/\s*[\[(]?\s*(?:dot|\.)\s*[\])]?\s*/gi, ".");
  return extractEmailFromText(normalized);
}

// Best public email scraped from a page: prefer an explicit mailto:, then a
// Cloudflare-protected address, then plain text, then de-obfuscated text.
function emailFromPage(html: string): string | null {
  if (!html) return null;
  const mailto = mailtoEmails(html);
  if (mailto.length) return mailto[0];
  const cf = cloudflareEmails(html);
  if (cf.length) return cf[0];
  // Strip <script>/<style> before scanning visible text — minified bundles
  // contain strings (chunk filenames, code) that the email regex mistakes for
  // addresses (e.g. "fe@ures-cnrrqvbo.js"). Only scan human-visible content.
  const visible = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  return extractEmailFromText(visible) ?? deobfuscatedEmail(visible);
}

// Parse a GitHub username out of a profile URL (github.com/<user>), ignoring
// repo/org sub-pages and reserved paths.
function githubUser(url: string): string | null {
  const m = url.match(/github\.com\/([^/?#]+)/i);
  if (!m) return null;
  const user = m[1];
  if (!user || /^(orgs|sponsors|about|features|topics|collections)$/i.test(user))
    return null;
  return user;
}

async function emailFromGithub(url: string): Promise<string | null> {
  const user = githubUser(url);
  if (!user) return null;
  // The public API exposes a `email` field when the user has set it public.
  const json = await fetchTextSafe(`https://api.github.com/users/${user}`, {
    Accept: "application/vnd.github+json",
  });
  if (json) {
    try {
      const data = JSON.parse(json) as { email?: string | null };
      if (isEmail(data.email)) return data.email!.trim().toLowerCase();
    } catch {
      // ignore malformed JSON
    }
  }
  // Fall back to scraping the profile page (pinned README, bio, etc.).
  return emailFromPage(await fetchTextSafe(`https://github.com/${user}`));
}

// Order links by how likely they are to expose a real contact email and how
// scrapeable they are. Personal sites and GitHub win; JS-walled platforms
// (LinkedIn, Instagram, X) are tried last and rarely yield anything.
function rank(url: string): number {
  const u = url.toLowerCase();
  if (/github\.com/.test(u)) return 0;
  if (/(twitter\.com|x\.com|linkedin\.com|instagram\.com|youtube\.com|t\.co)/.test(u))
    return 3;
  return 1; // personal / company website
}

function isPlatform(url: string): boolean {
  return /(github\.com|twitter\.com|x\.com|linkedin\.com|instagram\.com|youtube\.com|youtu\.be|t\.co)/i.test(
    url,
  );
}

// For a personal/company site, scrape the homepage plus the usual contact pages
// where an email most often lives.
async function emailFromWebsite(url: string): Promise<string | null> {
  const home = emailFromPage(await fetchTextSafe(url));
  if (isEmail(home)) return home;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  for (const path of ["/contact", "/about", "/contact-us", "/imprint"]) {
    const email = emailFromPage(await fetchTextSafe(origin + path));
    if (isEmail(email)) return email;
  }
  return null;
}

/**
 * Try to discover a public contact email by visiting a guest's social/website
 * links and scanning each page (and the GitHub API) for one. Best-effort and
 * network-bound — returns the first usable address, or null.
 */
export async function findEmailFromSocials(
  links: (string | null | undefined)[],
): Promise<string | null> {
  const urls = [...new Set(links.map((l) => l?.trim()).filter(Boolean) as string[])]
    .filter((u) => /^https?:\/\//i.test(u))
    .sort((a, b) => rank(a) - rank(b));

  for (const url of urls) {
    const email = /github\.com/i.test(url)
      ? await emailFromGithub(url)
      : isPlatform(url)
        ? emailFromPage(await fetchTextSafe(url))
        : await emailFromWebsite(url);
    if (isEmail(email)) return email!.trim().toLowerCase();
  }
  return null;
}
