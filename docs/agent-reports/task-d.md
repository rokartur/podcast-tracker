# Task D — Guests + Tasks + AI/scrape UI

## Files created
- `src/lib/actions/guests.ts` — `createGuest` / `updateGuest` / `deleteGuest`. zod-validated, teamId-scoped, ownership filter on update/delete, `revalidatePath("/guests")`.
- `src/lib/actions/tasks.ts` — `createTask` / `updateTaskStatus` / `deleteTask`. teamId-scoped, ownership filter, `revalidatePath("/tasks")`.
- `src/app/(app)/guests/page.tsx` — server component. Sections: AI suggest, WWW scraper, manual form, saved-guests list (teamId, `desc(createdAt)`).
- `src/app/(app)/guests/guest-suggest.tsx` — client. POST `/api/guests/suggest`, suggestion cards, "Zapisz jako gościa" → `createGuest`.
- `src/app/(app)/guests/guest-scrape.tsx` — client. POST `/api/scrape`, prefilled editable form → `createGuest`, shows `rawTextPreview`.
- `src/app/(app)/guests/guest-form.tsx` — client. Manual add, clears on success.
- `src/app/(app)/guests/guest-list.tsx` — client wrapper (permitted by spec OR-clause). Client-side search by name/topics + delete-with-confirm. Friendly empty states.
- `src/app/(app)/tasks/page.tsx` — server component. 3-column kanban (todo/doing/done), move ←/→ + delete via **inline server actions** (form-based, no extra client file), episode join, due date, `TaskForm` at top.
- `src/app/(app)/tasks/task-form.tsx` — client. title (req) + episode select + due date → `createTask`.

## Key decisions
- **Stack is Next 16.2.9 + React 19 + Zod 4**, not Next 15. Adjusted accordingly:
  - Zod 4: used `z.email()` (top-level) instead of deprecated `z.string().email()`.
  - `jsx: react-jsx` + module files: `React.FormEvent`/`React.ReactNode` are UMD-global errors without an import, so added `import type React from "react"` to every file referencing `React.*`.
- Guest search + delete-confirm consolidated into one client wrapper (`guest-list.tsx`) — the spec explicitly allows a small client list wrapper.
- Tasks kanban move/delete done with **inline `"use server"` form actions** in `page.tsx` (read FormData → call object-arg actions), avoiding an extra client file and keeping the page a server component. Move buttons disabled at column ends.
- All AI fetches handle non-200: HTTP 500 → "Skonfiguruj klucz AI w .env"; other errors → friendly Polish messages. `credentials` are same-origin by default.
- Actions return a `{ok}|{ok,error}` result union so client components show inline Polish errors instead of throwing.
- guest `topics` stored comma-separated, `links` newline/comma-separated (matches schema comments); empty strings normalized to `null`.

## TODOs / blockers
- **`tsc --noEmit` could not be run** — the command is blocked by the sandbox/permission policy in this environment (every variant returned "This command requires approval"). Types were reviewed manually instead (see below). Please run `npx tsc --noEmit` to confirm.
- `(app)` route-group layout is owned by another agent — not created here. Pages assume it exists.
- AI endpoints (`/api/guests/suggest`, `/api/scrape`) owned by another agent — called via fetch only.

## tsc result
Not executed — blocked by permission policy. Manual review of my files found no type errors: action result unions narrow correctly in clients, drizzle select shapes match component props, nullable columns handled, Zod 4 / React-import fixes applied.
