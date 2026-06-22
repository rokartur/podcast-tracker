import "server-only";

// Lightweight in-memory rate limiter (per-process). Good enough for a
// single-instance deployment to blunt abuse of expensive AI/scrape actions; a
// multi-instance deployment would need a shared store (Redis). Keyed by an
// arbitrary string (e.g. `findGuests:<teamId>`).

type Bucket = { count: number; resetAt: number };

const globalForRl = globalThis as unknown as {
  __rateLimitBuckets?: Map<string, Bucket>;
};
const buckets: Map<string, Bucket> =
  globalForRl.__rateLimitBuckets ?? new Map();
globalForRl.__rateLimitBuckets = buckets;

/**
 * Fixed-window limiter. Returns { ok: true } when the call is allowed, or
 * { ok: false, retryAfterMs } when the key has exceeded `limit` calls within
 * `windowMs`. `now` is injected only for tests.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): { ok: true } | { ok: false; retryAfterMs: number } {
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (b.count >= limit) {
    return { ok: false, retryAfterMs: b.resetAt - now };
  }
  b.count++;
  return { ok: true };
}
