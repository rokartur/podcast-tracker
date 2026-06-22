import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// ---------------------------------------------------------------------------
// SSRF-hardened outbound fetch.
//
// Several features fetch URLs that ultimately derive from untrusted input (LLM
// output built from scraped video descriptions, or a user-supplied topic). A
// raw fetch() to such a URL lets an attacker reach internal services, cloud
// metadata (169.254.169.254), or loopback. `safeFetchText` enforces:
//   - http/https only
//   - the resolved IP of every host (including each redirect hop) is public
//   - a bounded number of redirects, each re-validated
//   - a hard timeout
//   - a response-body byte cap (so a huge/hostile body can't exhaust memory)
// ---------------------------------------------------------------------------

export type SafeFetchOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  method?: "GET" | "POST";
  body?: string;
};

class SsrfError extends Error {}

function ipv4ToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function inV4Range(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

// Blocked IPv4 ranges: any-host, loopback, RFC1918 private, link-local
// (incl. cloud metadata 169.254.169.254), CGNAT, benchmarking, reserved.
const BLOCKED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "192.88.99.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

function isPublicIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return !BLOCKED_V4.some((c) => inV4Range(ip, c));
  if (kind === 6) {
    const v = ip.toLowerCase();
    // Loopback, unspecified.
    if (v === "::1" || v === "::") return false;
    // Any IPv4 embedded in the v6 address (mapped ::ffff:, deprecated
    // compat ::, or NAT64 64:ff9b::) must be validated as that v4. The WHATWG
    // URL parser canonicalizes mapped literals to HEX (e.g. ::ffff:7f00:1 for
    // 127.0.0.1, ::ffff:a9fe:a9fe for 169.254.169.254), so the dotted form
    // alone is not enough — decode both notations.
    const embedded = embeddedV4(v);
    if (embedded) return isPublicIp(embedded);
    // NAT64 well-known prefix (64:ff9b::/96) without a decodable tail — block.
    if (v.startsWith("64:ff9b:")) return false;
    // Unique-local fc00::/7 and link-local fe80::/10.
    if (/^f[cd]/.test(v)) return false;
    if (/^fe[89ab]/.test(v)) return false;
    return true;
  }
  return false;
}

// Extract a dotted IPv4 string from an IPv4-mapped / -compatible / NAT64 IPv6
// address in EITHER dotted (::ffff:1.2.3.4) or hex (::ffff:0102:0304) notation.
// Returns null when the address embeds no IPv4.
function embeddedV4(v6: string): string | null {
  const dotted = v6.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  const hex = v6.match(/^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return [(a >> 8) & 255, a & 255, (b >> 8) & 255, b & 255].join(".");
  }
  return null;
}

/**
 * True when `url` is an http(s) URL whose host resolves only to public IPs.
 * Never throws — for callers that just want a yes/no gate.
 */
export async function isPublicUrl(url: string | null | undefined): Promise<boolean> {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  try {
    await assertPublicHost(parsed.hostname);
    return true;
  } catch {
    return false;
  }
}

/** Throw unless `hostname` resolves only to public IP addresses. */
export async function assertPublicHost(hostname: string): Promise<void> {
  // Hostname may already be an IP literal (strip IPv6 brackets).
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    if (!isPublicIp(literal)) {
      throw new SsrfError(`Blocked non-public address: ${literal}`);
    }
    return;
  }
  if (hostname.toLowerCase() === "localhost") {
    throw new SsrfError("Blocked host: localhost");
  }
  let addrs;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    throw new SsrfError(`DNS resolution failed for ${hostname}`);
  }
  if (addrs.length === 0) throw new SsrfError(`No address for ${hostname}`);
  for (const a of addrs) {
    if (!isPublicIp(a.address)) {
      throw new SsrfError(`Blocked non-public address ${a.address} for ${hostname}`);
    }
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  }
  return new TextDecoder("utf-8").decode(concat(chunks));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * SSRF-safe text fetch. Returns the response body (capped) or throws. Follows
 * redirects manually, re-validating each hop's host against the block list.
 */
export async function safeFetchText(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<string> {
  const {
    headers = {},
    timeoutMs = 8000,
    maxBytes = 2_000_000,
    maxRedirects = 3,
    method = "GET",
    body,
  } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        throw new SsrfError(`Invalid URL: ${current}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new SsrfError(`Blocked scheme: ${parsed.protocol}`);
      }
      await assertPublicHost(parsed.hostname);

      const res = await fetch(current, {
        method,
        headers,
        body: method === "POST" ? body : undefined,
        redirect: "manual",
        signal: controller.signal,
      });

      // Manual redirect handling so we can re-validate the next host.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return "";
        current = new URL(loc, current).toString();
        // Drain the redirect body.
        await res.body?.cancel().catch(() => {});
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${current}`);
      return await readCapped(res, maxBytes);
    }
    throw new SsrfError(`Too many redirects for ${url}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Same as safeFetchText but returns "" on any failure (best-effort callers). */
export async function safeFetchTextSafe(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<string> {
  try {
    return await safeFetchText(url, opts);
  } catch {
    return "";
  }
}
