# Task B — Auth UI + App Shell + Dashboard + Invite

## Files created / edited

| File | Action |
|------|--------|
| `src/app/layout.tsx` | edit — title/description PL, dark `<body>` classes |
| `src/app/page.tsx` | replace — `redirect("/dashboard")` |
| `src/app/login/page.tsx` | new — server card, redirects logged-in users |
| `src/app/login/login-form.tsx` | new — client email/password sign-in |
| `src/app/invite/[token]/page.tsx` | new — validates invite, renders accept form |
| `src/app/invite/[token]/accept-form.tsx` | new — client join form |
| `src/lib/actions/invite.ts` | new — `acceptInvite`, `createInvite` server actions |
| `src/app/(app)/layout.tsx` | new — app shell, `requireMember()` + `<Nav>` |
| `src/components/nav.tsx` | new — client nav bar, active link, sign-out |
| `src/app/(app)/dashboard/page.tsx` | new — greeting + 4 stat cards + quick links |

## Key decisions

**Auth flow.** Login uses `authClient.signIn.email({ email, password, callbackURL })`. On error → red "Błędny email lub hasło". On success → `router.push(next || "/dashboard")` where `next` comes from `?next=` searchparam. Login page redirects already-authed users via `getOptionalSession()`.

**Invite-accept flow.** Public sign-up is disabled in `auth.ts` (`disableSignUp: true`), so accounts are created server-side only:
1. `invite/[token]/page.tsx` looks up invitation with combined SQL guard (`token` match AND `acceptedAt IS NULL` AND `expiresAt > now`); invalid → friendly "Zaproszenie wygasło lub jest nieprawidłowe".
2. `acceptInvite` re-runs the same guard (defence in depth), validates `password.length >= 10` (`throw "Hasło min. 10 znaków"`), then `auth.api.createUser({ body:{ email, password, name, role:"user" } })` (admin plugin). New id from `created.user.id` (return type `{ user: UserWithRole }` — verified in `admin.d.mts`).
3. Inserts `teamMember` with `invitation.role`, marks `invitation.acceptedAt = new Date()`.
4. Client redirects to `/login?invited=1`.

**createInvite.** `requireMember()`; only `owner`/`admin` may invite (else throw). 7-day expiry via `Date.now() + 7d`. Returns `{ token }`, `revalidatePath("/team")`.

**App shell.** `(app)/layout.tsx` calls `requireMember()` once and wraps all sibling routes (`/podcasts /episodes /guests /tasks` owned by other agents) with `<Nav>` + centered `<main>`.

**Dashboard counts.** `count()` from drizzle, team-scoped. Open tasks = `ne(task.status, "done")`. All 4 counts run via `Promise.all`. Empty-state hint shown per card when value is 0.

## TODOs / blockers

- **tsc not run:** `npx tsc --noEmit` was blocked by the sandbox permission prompt (could not auto-approve). No code-level type errors expected — the one nontrivial type (`createUser` return → `created.user.id`) was verified directly against `node_modules/better-auth/dist/plugins/admin/admin.d.mts:213-215` (`{ user: UserWithRole }`). Recommend running `npx tsc --noEmit` manually to confirm.
- Pages `/podcasts /episodes /guests /tasks` are owned by other agents; nav links and dashboard quick-links will 404 until those land.

## tsc result

Not executed (permission-blocked). Manual type verification passed for the only ambiguous call.
