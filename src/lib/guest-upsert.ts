import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { guest } from "@/db/schema";
import { buildLinks, dedupeTopics, filterReachableLinks } from "@/lib/guest-utils";

// Fields a caller supplies to describe a guest. All optional except name.
export type GuestInput = {
  name: string;
  role?: string | null;
  image?: string | null;
  bio?: string | null;
  email?: string | null;
  topics?: string | null; // comma-separated
  context?: string | null;
  links?: string | null; // newline-separated
  notes?: string | null;
  youtubeSubscribers?: number | null;
  xFollowers?: number | null;
};

// Keep the larger of two reach counts (null = unknown).
function maxReach(a?: number | null, b?: number | null): number | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.max(a, b);
}

// Trim and cap a free-text field. The cap bounds DB bloat from
// LLM/scrape-derived values (which are otherwise unbounded text columns).
function clean(v?: string | null, maxLen = 8000) {
  const t = v?.trim();
  if (!t) return null;
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

/**
 * Insert a guest — or, when one with the same name already exists for this team,
 * merge the new info into that row instead of creating a duplicate. Guests in
 * the table are therefore unique by (teamId, lower(name)).
 *
 * Merge is additive and non-destructive: existing scalar fields win, empty ones
 * are filled in, and list-like fields (topics, links) and context are unioned.
 *
 * Returns the row id and whether a new row was created (`inserted: false` means
 * an existing guest was enriched).
 */
export async function upsertGuestByName(
  teamId: string,
  input: GuestInput,
): Promise<{ id: string; inserted: boolean } | null> {
  const name = input.name?.trim().slice(0, 200);
  if (!name) return null;

  // Match case-insensitively and whitespace-insensitively (collapse runs of
  // whitespace) so "Sam  Altman" and "Sam Altman" are treated as the same guest
  // and merged instead of producing duplicate rows.
  const normalized = name.toLowerCase().replace(/\s+/g, " ");
  const [existing] = await db
    .select()
    .from(guest)
    .where(
      and(
        eq(guest.teamId, teamId),
        sql`regexp_replace(lower(${guest.name}), '\s+', ' ', 'g') = ${normalized}`,
      ),
    )
    .limit(1);

  if (!existing) {
    const id = crypto.randomUUID();
    await db.insert(guest).values({
      id,
      teamId,
      name,
      role: clean(input.role),
      image: clean(input.image),
      bio: clean(input.bio),
      email: clean(input.email),
      topics: clean(input.topics),
      context: clean(input.context),
      links: clean(await filterReachableLinks(input.links)),
      notes: clean(input.notes),
      youtubeSubscribers: input.youtubeSubscribers ?? null,
      xFollowers: input.xFollowers ?? null,
    });
    return { id, inserted: true };
  }

  // Merge into the existing row. Keep what's already there, fill the gaps.
  const mergedTopics = dedupeTopics([
    ...(existing.topics?.split(",") ?? []),
    ...(input.topics?.split(",") ?? []),
  ]);
  const mergedLinks = await filterReachableLinks(
    buildLinks([
      ...(existing.links?.split("\n") ?? []),
      ...(input.links?.split("\n") ?? []),
    ]),
  );
  // Append new context only when it isn't already recorded.
  const newContext = clean(input.context);
  const haveContext = clean(existing.context);
  const mergedContext =
    newContext && (!haveContext || !haveContext.includes(newContext))
      ? [haveContext, newContext].filter(Boolean).join(" — ")
      : haveContext;

  await db
    .update(guest)
    .set({
      role: clean(existing.role) ?? clean(input.role),
      image: clean(existing.image) ?? clean(input.image),
      bio: clean(existing.bio) ?? clean(input.bio),
      email: clean(existing.email) ?? clean(input.email),
      topics: clean(mergedTopics),
      context: mergedContext,
      links: clean(mergedLinks),
      notes: clean(existing.notes) ?? clean(input.notes),
      youtubeSubscribers: maxReach(
        existing.youtubeSubscribers,
        input.youtubeSubscribers,
      ),
      xFollowers: maxReach(existing.xFollowers, input.xFollowers),
    })
    .where(eq(guest.id, existing.id));

  return { id: existing.id, inserted: false };
}
