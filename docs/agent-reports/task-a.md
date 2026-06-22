# Task A — AI provider layer + scraper + API routes

## Files created
- `src/lib/ai/provider.ts` — provider-agnostic `llmJson<T>()` (Anthropic + OpenRouter).
- `src/lib/scraper.ts` — `scrapeUrl()` with SSRF guard.
- `src/lib/ai/suggest.ts` — `suggestGuests(topic, count)` → `GuestSuggestion[]`.
- `src/lib/ai/extract.ts` — `extractGuestFromUrl(url)` → `{ guest, rawTextPreview }`.
- `src/app/api/guests/suggest/route.ts` — POST, auth + rate limit + zod.
- `src/app/api/scrape/route.ts` — POST, auth + rate limit + zod.

## Key decisions

### Provider dispatch (`provider.ts`)
- `resolveProvider()`: honors `AI_PROVIDER` if set to a valid value; else infers
  `openrouter` when `OPENROUTER_API_KEY` present, otherwise `anthropic`.
- Anthropic path: `@anthropic-ai/sdk` `messages.create`; pulls first `text` block,
  strips ```` ```json ```` fences, `JSON.parse`. Default model `claude-opus-4-8`.
- OpenRouter path: raw `fetch` to `${base}/chat/completions` with
  `response_format: { type: "json_object" }`, `HTTP-Referer` + `X-Title` headers.
  Default model `openai/gpt-4o-mini`. Throws on non-200 with body text.
- Missing API key for the selected provider → clear `Error`.
- `server-only` import; no client code.

### SSRF guard (`scraper.ts`)
- `new URL()` parse (throws → "blocked host"); only `http:`/`https:`.
- Blocked hosts: `localhost`, `*.local`, `*.internal`; IPv4 literals
  `127.*`, `10.*`, `192.168.*`, `172.16-31.*`, `169.254.*`, `0.*`;
  IPv6 `::1`, `fe80:` (link-local), `fc`/`fd` prefix (fc00::/7 unique-local).
  Violation → `Error("blocked host")`.
- `AbortController` 8s timeout, UA `PodcastTrackerBot/1.0`, `redirect: "follow"`.
- Rejects non-2xx and non-`text/html`. Body capped at 500_000 chars.
- Strips `<script>`/`<style>`, removes tags, decodes common entities, collapses
  whitespace, extracts `<title>`.

### API routes
- Local `getAuth()` helper: `auth.api.getSession({ headers })` → loads `teamId`
  from `teamMember` by `userId`; returns `null` (→ 401) if no user/team.
- In-memory sliding-window rate limit: 10 req / 60s per `userId` (module Map) → 429.
- zod validation → 400. `try/catch` → 500 `{ error }` (no stack leak).
- `scrape`: `blocked host` → 400 with message `"Nie można pobrać tej strony"`.
- Both `export const runtime = "nodejs"`.

## TODOs / blockers
- **`npx tsc --noEmit` blocked by sandbox permission** (`This command requires
  approval`) — could not execute the typecheck. Code reviewed manually; no
  type errors expected. Re-run `npx tsc --noEmit -p tsconfig.json` once approved.
- Note: zod v4 deprecates `z.string().url()` in favor of `z.url()`; still
  functional. Swap if deprecation warnings are undesirable.
- Rate limiter is per-instance/in-memory (best-effort, resets on redeploy) — fine
  per spec; move to shared store (Redis) for multi-instance correctness later.

## tsc result
Not run — blocked by command-approval permission. See blocker above.
