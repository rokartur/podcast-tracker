# Podcast Tracker — Security & Performance Audit

_Date: 2026-06-22 · Scope: full `src/` tree (Next.js 16 / better-auth / drizzle / postgres / Anthropic|OpenRouter). 46 files, ~5.7k LOC._

> Note: the codebase was being actively edited during the audit (e.g. `channel-scrape.ts` gained `rewriteChannelContext` mid-pass). Line numbers reflect the state read at audit time.

## Architecture (one-paragraph)

Invite-only team app. better-auth (email+password, public sign-up disabled) → sessions validated against DB in `requireMember()`. Multi-tenant: every app row carries `teamId`; queries are team-scoped. Core feature scrapes **one hardcoded YouTube channel** (`DAVID_ONDREJ_HANDLE`) via undocumented RSS + InnerTube endpoints (no API key), feeds video title/description/transcript to an LLM to extract "guests", then enriches each guest by **fetching their social/website URLs server-side** (email + follower-count scraping). A second feature (`findAndSaveGuests`) takes a **user free-text topic** → LLM → same enrichment. Background scans run detached in an in-memory manager, observed over SSE. A cron endpoint (bearer secret) runs daily scans.

The central risk theme: **untrusted text (scraped pages, user topics) → LLM → output trusted as URLs/emails that are fetched server-side and rendered client-side.** That chain produces the SSRF and stored-XSS findings below.

---

## Findings (severity-ranked)

> Corroborated by a 75-agent adversarial-verification workflow: 51 findings confirmed, 15 rejected (incl. plausible-but-wrong: avatar `<img>` XXE/SSRF, postgres pool timeout, `guest.email` index, index-keyed React lists), 11 added by a completeness critic. Findings below survived that pass.

### HIGH

**H0 — Privilege escalation: `createInvite` trusts the client-supplied `role`**
`src/lib/actions/invite.ts:60-81`. The signature says `role?: "admin" | "member"`, but that is **compile-time only** — a `"use server"` action receives arbitrary deserialized client input. At line 77 the value is written straight to the DB (`role: input.role ?? "member"`), and `invitation.role` is the `memberRole` enum which **includes `"owner"`** (`schema.ts:79,120`). The authz check (line 66) only gates the *caller* (`owner`/`admin`), never the *granted* role. `acceptInvite` then copies `inv.role` verbatim into `teamMember` (`:51`). So any team admin can `createInvite({ email, role: "owner" })` and mint an owner-level account.
- _Impact:_ vertical privilege escalation (admin → owner) within a tenant; owner typically gates destructive/billing actions. Bounded to the caller's own team (teamId from `requireMember`, not client).
- _Fix:_ zod-parse the input; allowlist the granted role to `member`/`admin`; additionally forbid a non-owner from granting `admin` (admins invite `member` only); never grant `owner` via invite.

**H1 — Stored XSS via `javascript:` URLs in guest links**
`src/app/(app)/guests/guest-list.tsx:314` renders `<a href={l}>` where `l` comes from `buildLinks()` (`src/lib/guest-utils.ts:21`), which performs **no scheme validation**. Link values originate from LLM output (`extractPeopleFromVideo` / `suggestGuests`) which in turn is derived from untrusted scraped descriptions/transcripts or a user-supplied topic. React does **not** block `javascript:` in `href`. A `javascript:alert(...)` (or `data:`) URL planted into a guest record executes in the authenticated session on click.
- _Impact:_ stored XSS → session/data theft within a team, in an admin-capable app.
- _Fix:_ allowlist schemes (`http`/`https`/`mailto`) in `buildLinks` and again at render; drop anything else. Add a CSP (see H2) as defense-in-depth.

**H2 — No security headers at all**
`next.config.ts` is empty — no `headers()`. Missing CSP, `X-Frame-Options`/`frame-ancestors` (clickjacking), `X-Content-Type-Options`, `Referrer-Policy`, HSTS, `Permissions-Policy`.
- _Impact:_ clickjacking; no CSP backstop for H1; MIME sniffing.
- _Fix:_ add an `async headers()` returning a strict CSP (`default-src 'self'`, allow `unavatar.io` images), `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, HSTS in prod.

### MEDIUM

**M1 — SSRF: outbound fetches have no host/IP allowlist**
`src/lib/email-finder.ts` (`findEmailFromSocials` → `fetchTextSafe`) and `src/lib/reach.ts` fetch URLs derived from LLM output. `findEmailFromSocials` accepts any `https?://` incl. `http://169.254.169.254/...`, `http://localhost`, `http://10.0.0.x`, and follows redirects (`redirect: "follow"`); it also probes `origin + /contact|/about|...`. `fetchReachFromLinks` gates on `isYoutube`/`isX` which are **substring** tests — `http://169.254.169.254/#youtube.com` passes and gets fetched.
- _Impact:_ (blind-ish) SSRF to cloud metadata / internal services / port-scan from the server. Reachable by any authenticated team member via `findAndSaveGuests` (user controls the topic → steers LLM URLs), or via scraped channel content. Currently dampened because the scrape **target** channel is hardcoded, but `findAndSaveGuests` is a live user-driven path.
- _Fix:_ resolve the host and reject private/loopback/link-local ranges (before and after each redirect), force `https`, cap redirect count, and cap response bytes.

**M2 — Prompt injection → unvalidated LLM output persisted & rendered**
`src/lib/ai/provider.ts:57` does `JSON.parse(stripFences(...))` then a bare TypeScript cast — **no runtime schema validation** of the model's JSON. Fields (`name`, `bio`, `email`, six URL fields) are written to DB and shown in the UI; only `email` is checked (`isEmail`). Scraped descriptions/transcripts and the user topic are attacker-influenceable inputs to the prompt.
- _Impact:_ data poisoning, and the delivery mechanism for H1 (malicious URL) and M1 (internal URL).
- _Fix:_ validate the model JSON with zod; normalize/allowlist every emitted URL (scheme + public host); cap field lengths.

**M3 — `CRON_SECRET` compared non-constant-time + accepted in query string**
`src/app/api/cron/scrape/route.ts:38` `provided !== secret` (timing oracle), and the secret is accepted as `?secret=` (`:36`) → leaks into access logs, proxies, browser history.
- _Fix:_ `crypto.timingSafeEqual` over fixed-length buffers; accept the `Authorization` header only.

**M4 — No explicit auth rate-limiting / lockout**
`src/lib/auth.ts` does not configure better-auth `rateLimit`; sign-in relies on library defaults, with no account lockout. Invite-only narrows exposure but credential-stuffing against known emails remains.
- _Fix:_ configure better-auth `rateLimit` (strict on `/sign-in`), consider lockout/backoff.

### LOW

- **L1 — State change on GET:** `GET /api/channel/scan?start=1` starts a scan. SameSite=Lax blocks subresource CSRF, but a top-level navigation can trigger it. Idempotent → low. _Fix: require POST to start._
- **L2 — Invite-accept TOCTOU:** `src/lib/actions/invite.ts` checks `acceptedAt IS NULL` then updates without a transaction/row lock. Duplicate `createUser` is blocked by the unique email, so impact is low. _Fix: wrap in a transaction with an atomic conditional update._
- **L3 — Self prompt-injection:** `rewriteChannelContext(customPrompt)` injects user text into the LLM system prompt; user-owns-data, output rendered escaped → info/low.
- **L4 — `create-admin --password` on CLI:** visible in process list / shell history. _Prefer the hidden prompt path._
- **L5 — No DB TLS config** (`src/db/index.ts`): fine for local docker; enforce `sslmode=require` for a remote prod DB.
- **L6 — Open redirect via login `next`:** `src/app/login/login-form.tsx` reads `?next=` and feeds it to `router.push(next)` (and `callbackURL`) unvalidated. `callbackURL` is partly bounded by `trustedOrigins`, but `router.push("//evil.example")` is not → phishing bounce. _Fix: only honor `next` when it starts with `/` and not `//` (path-only, same-origin)._
- **L7 — AI error text leaked to client:** `findAndSaveGuests` returns the raw `e.message` (`guests.ts:67`), and `provider.ts` echoes the OpenRouter upstream body into the thrown error. Internal detail disclosure. _Fix: log server-side, return a generic message._
- **L8 — No global error boundary:** no `error.tsx`/`global-error.tsx`/`not-found.tsx` under `src/app`. Unhandled server-action/RSC errors surface raw to the client. _Fix: add error boundaries; never render raw `Error.message`._
- **L9 — Account enumeration on invite accept:** `acceptInvite` throws distinguishable errors — "invalid or expired" vs. the `createUser` duplicate-email error — letting a token holder learn whether an email is already registered. Also the invite page renders the invited email to anyone holding the token. _Fix: uniform error; consider not echoing the email._
- **L10 — No length/format caps on user input:** `createInvite` email, `acceptInvite` name, and guest free-text fields are unbounded `text` with no validation (`zod` is a dependency but unused in any action). DB bloat / abuse surface. _Fix: zod with length caps + email format on every action._
- **L11 — Non-deterministic team selection:** `requireMember()` (and the scan routes) do `.limit(1)` with **no `ORDER BY`** on `teamMember` (`session.ts:18-27`). A user in >1 team gets an arbitrary team per request. Correctness/authz drift. _Fix: deterministic order, or an explicit active-team concept._
- **L12 — Structural gaps:** zero tests, no rate-limiting dependency, `zod` unused. Trust-boundary code (server actions) has no automated coverage.

---

## Performance & correctness

### HIGH

**P1 — Fully sequential network/AI work in the scrape core**
`src/lib/channel-scrape-core.ts` processes each new video serially, and within each video each detected person serially does: `findEmailFromSocials` (homepage + up to 4 contact pages + GitHub API/page) + `fetchReachFromLinks` (2 fetches) + upsert. With `maxPerRun=25` and multiple people/video and ~10s timeouts, one batch can run for many minutes.
- _Fix:_ bound concurrency (a promise pool, e.g. 4–6) across videos and across per-person enrichment.

**P2 — `findAndSaveGuests` blocks on up to 20× heavy enrichment, serially**
`src/lib/actions/guests.ts:78` loops up to 20 suggestions, each doing the same multi-fetch enrichment, in one server action with no concurrency/streaming → long-running request, risk of timeout.
- _Fix:_ same promise-pool approach; consider streaming progress like the scan does.

**P3 — Cron runs all channels sequentially in one request**
`src/app/api/cron/scrape/route.ts:60` `for (const ch of channels) await scrapeChannelForTeam(...)`. Each is heavy; many teams → exceeds any function timeout.
- _Fix:_ bounded concurrency, or fan out per-channel invocations / a queue.

### MEDIUM

**P4 — In-memory scan manager is single-instance only**
`src/lib/scan-manager.ts` keeps scan state in a module `Map`. On serverless/multi-instance, the SSE observer can land on a different instance than the one running the scan (→ false "idle"), and the detached `for`-loop (up to 200 batches) can be frozen/killed after the HTTP response returns. Buffer cap (600) and 60s GC are fine. **This only works on a single long-lived Node instance** (the code comments acknowledge it).
- _Fix:_ for any serverless/multi-instance deploy, move scan state + pub/sub to a shared store (Redis/Postgres LISTEN-NOTIFY) and run scans on a worker, not a request.

**P5 — Channel context rebuilt every batch**
`channel-scrape-core.ts` step 6 reads **all** remembered videos and makes an AI call (`synthesizeChannelContext`) after *every* 25-video batch. During a full back-catalogue scan (dozens of batches) that's dozens of full-table reads + dozens of AI calls just to rebuild the same overview.
- _Fix:_ rebuild once at end-of-scan (or when no more new/stale videos remain).

**P6 — Guest upsert: no DB uniqueness + unindexed lookup**
`src/lib/guest-upsert.ts` does select-then-insert keyed on `lower(name)`; there is no `unique(teamId, lower(name))` constraint and no functional index (only `guest_team_idx` on `teamId`). Concurrent user-action + scan can create duplicate guests, and the lookup isn't index-backed.
- _Fix:_ add a functional unique index `(teamId, lower(name))` and use `onConflict` upsert.

**P7 — Unbounded response bodies**
All scrapers do `res.text()` with timeouts but **no byte cap**; a huge (or malicious internal) response is fully buffered → memory pressure. Email/de-obfuscation regexes also run over the full HTML.
- _Fix:_ cap bytes read (stream + abort past N KB); cap regex input length.

**P8 — `new Anthropic({apiKey})` per call**
`src/lib/ai/provider.ts:43` constructs a client on every `llmJson`. _Fix: module-level singleton._

**P-T — Missing timeouts on the hottest calls** _(correction to my first pass — not every fetch is guarded)_
The InnerTube continuation **POST** (`src/lib/youtube.ts:318`) and both LLM calls (Anthropic SDK + the OpenRouter `fetch`, `provider.ts:44,71`) have **no `AbortController`/timeout**. A single hung continuation page or stalled model call blocks the entire (already sequential) scan indefinitely. `fetchText`/`fetchPage` are guarded (10s); these are not.
- _Fix:_ wrap the browse POST and LLM calls in an abort/timeout; set the SDK's `timeout` option.

**P-C — No caching/memoization of repeated fetches across batches**
The same YouTube watch pages and per-guest email/reach pages are re-fetched on every batch and re-run; nothing is memoized. Combined with P5 (per-batch context rebuild) this multiplies network + AI work during a full scan.
- _Fix:_ cache within a scan run (and across batches) keyed by videoId / URL.

### Frontend (guest table + SSE)

- **FE1 (medium) — No table virtualization:** `guest-list.tsx` renders every guest row to the DOM; large teams → heavy DOM + slow interaction. _Fix: virtualize rows._
- **FE2 (medium) — `router.refresh()` on every SSE `done` batch:** `channel-scrape.tsx` triggers a full RSC refetch per batch event during a scan — repeated server round-trips. _Fix: refresh once on finish (or update state locally)._
- **FE3 (medium) — SSE reconnect has no backoff/cap:** on error the client reconnects with no backoff → reconnect-storm risk against the SSE route. _Fix: exponential backoff + attempt cap._
- **FE4 (low) — Whole guest table re-renders per search keystroke** (no row memoization) and **one `unavatar.io` request per visible row on mount** (`guest-list.tsx:44-72`). _Fix: memoize rows; lazy-load avatars._

### LOW (data layer)

- **P9 — `scheduleEnabled` is ignored by cron (correctness bug):** the cron selects *all* channels and runs any matching the current hour, never filtering on `scheduleEnabled`. Disabling auto-scan in the UI has no effect. _Fix: `where(eq(channel.scheduleEnabled, true))`._
- **P10 — `force=1` cron bypass:** anyone holding `CRON_SECRET` can ignore the daily guard and re-run everything (YouTube/AI amplification). Behind the secret → low.

---

## What looks good (no action)

- `.env*` gitignored; no secrets committed; no `NEXT_PUBLIC_` on any sensitive value (only a public auth URL).
- Multi-tenant scoping is consistent: `requireMember()` re-validates the session against the DB, and mutations (`deleteGuest(s)`, schedule, scrape) are filtered by `teamId`; teamId is never trusted from the client.
- Invite tokens are `crypto.randomUUID()` (122-bit), single-use, 7-day expiry; account creation is server-side with hardcoded system role `user` (no privilege escalation), team role from the invitation.
- Login returns a generic error (no user enumeration). Passwords min-10, hashed by better-auth.
- No `dangerouslySetInnerHTML` anywhere; text fields are React-escaped (the XSS surface is limited to the `href` issue, H1).
- SSE client cleans up on unmount/error (`channel-scrape.tsx:174`); event buffer is capped.
- Postgres client is a singleton across HMR; schema has the right `teamId`/unique indexes.

---

## Recommended order

1. **H0** (zod-validate invite `role`) — one zod parse closes a vertical privesc; do first.
2. **H1 + H2** (scheme allowlist + CSP) — small, kills the only code-exec vector.
3. **M1 + M2** (SSRF host allowlist + zod-validate/normalize LLM URLs) — same fix surface as H1; a shared `zod` + URL-allowlist helper also covers L7/L10.
4. **P9** (one-line correctness fix), **M3** (timing-safe cron, drop `?secret=`), **P-T** (timeouts on InnerTube POST + LLM).
5. **P1/P2/P3** (bounded concurrency) + **P-C** (caching) + **FE2** (`router.refresh` once) — the main latency win.
6. **M4, P4/P5/P6, FE1/FE3** as deploy target and scale dictate.
