# Task C — Podcasts + Episodes CRUD

## Files created

**Server actions**
- `src/lib/actions/podcasts.ts` — `createPodcast` / `updatePodcast` / `deletePodcast`. zod-validated, `requireMember`, every write filtered by `teamId` (ownership). `revalidatePath("/podcasts")`.
- `src/lib/actions/episodes.ts` — `createEpisode` (verifies podcast belongs to team before insert), `updateEpisodeStatus`, `updateEpisode`, `deleteEpisode`. zod, ownership filters, `revalidatePath("/episodes")`.

**Podcasts UI** — `src/app/(app)/podcasts/`
- `page.tsx` — server comp. Lists team podcasts (desc createdAt) with episode count via `leftJoin` + `count` + `groupBy`. Cards link to `/episodes?podcast={id}`. Empty state + per-card delete.
- `podcast-form.tsx` — client. Title (req) + description, `useTransition`, clears on success, error state.
- `delete-podcast-button.tsx` — client. `confirm()` then `deletePodcast`.

**Episodes UI** — `src/app/(app)/episodes/`
- `page.tsx` — server comp. `searchParams` awaited (Next15 Promise). Optional `?podcast=` filter, newest first, podcast title shown per row, friendly empty states (no podcasts → link to `/podcasts`; no episodes → hint).
- `episode-form.tsx` — client. Podcast picker, title, status (Polish labels), notes.
- `episode-status-select.tsx` — client. 5-status `<select>`, optimistic state w/ rollback on failure, colored dot + badge.
- `delete-episode-button.tsx` — client. `confirm()` then `deleteEpisode`.
- `status-meta.ts` — shared status values + Polish labels + Tailwind colors (idea=neutral, scheduled=blue, recorded=amber, editing=purple, published=green).

## Key decisions
- Status meta extracted to `status-meta.ts` so form + select + page share one source of truth.
- Episode count uses `leftJoin` (podcasts with 0 episodes still show) + `count(episode.id)` + `groupBy`. Join condition also pins `episode.teamId` for safety.
- Status select is optimistic — updates UI immediately, rolls back if action returns `!ok`.
- Polish pluralization for episode count (odcinek / odcinki / odcinków).
- `(app)/layout.tsx` not created (owned by others / another agent); route group renders without it.

## TODOs / blockers
- `updatePodcast` / `updateEpisode` actions exist + ownership-safe but no edit UI wired yet (task spec only required quick status change UI). Edit forms can reuse these later.

## tsc result
**Could not run** — `npx tsc --noEmit` (and `node`/`.bin/tsc` variants) blocked by sandbox approval gate in this session; every invocation returned "This command requires approval".

Manual review of my files: imports (`@/db`, `@/db/schema`, `@/lib/session`, `drizzle-orm` `{ eq, and, desc, count }`, `zod`, `next/cache`, `next/link`) all resolve against existing modules. Types: zod `.optional().transform(v => v ? v : null)` yields `string | null` matching nullable text columns; `searchParams` typed as Promise per Next15; episode `status` cast to `EpisodeStatusValue` at the boundary. No cross-file type issues expected. **Recommend running `npx tsc --noEmit` once approved.**
