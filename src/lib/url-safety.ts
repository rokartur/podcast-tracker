// Isomorphic URL safety helpers (no node imports — safe in client components).
//
// Used to (a) keep only web-navigable links when assembling guest link lists,
// and (b) guard every `href`/`src` we render from LLM- or scrape-derived data
// against `javascript:`/`data:` and other script-bearing schemes. React does
// NOT block dangerous schemes in `href`, so this must be enforced explicitly.

const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const SAFE_WEB_SCHEMES = new Set(["http:", "https:"]);

// Control/whitespace codepoints (<= 0x20) can be used to smuggle a scheme past
// a naive parser, e.g. a tab inside "java<TAB>script:alert(1)". Any URL holding
// one is rejected outright.
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) <= 0x20) return true;
  }
  return false;
}

/** True when the string is an http(s) URL. */
export function isHttpUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    return SAFE_WEB_SCHEMES.has(new URL(raw.trim()).protocol);
  } catch {
    return false;
  }
}

/**
 * Return the URL unchanged if it is safe to use in an anchor `href`
 * (http/https/mailto), otherwise null. Anything that could execute script
 * (`javascript:`, `data:`, `vbscript:`, …) is rejected.
 */
export function safeLinkHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (hasControlChar(s)) return null;
  try {
    const u = new URL(s);
    return SAFE_LINK_SCHEMES.has(u.protocol) ? s : null;
  } catch {
    return null;
  }
}

/** Return the URL if it is http(s), else null — for image `src` / web links. */
export function safeWebUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (hasControlChar(s)) return null;
  try {
    return SAFE_WEB_SCHEMES.has(new URL(s).protocol) ? s : null;
  } catch {
    return null;
  }
}
