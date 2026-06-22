"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { channel, guest } from "@/db/schema";
import { requireMember } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { suggestGuests, type GuestSuggestion } from "@/lib/ai/suggest";
import { findOffTopicGuests } from "@/lib/ai/guest-relevance";
import { findCategory } from "@/lib/categories";
import { avatarFromLinks } from "@/lib/avatar";
import { buildLinks, dedupeTopics, isEmail } from "@/lib/guest-utils";
import { upsertGuestByName } from "@/lib/guest-upsert";
import { findEmailFromSocials } from "@/lib/email-finder";
import {
  fetchReachFromLinks,
  fetchYoutubeSubscribers,
  isX,
  isYoutube,
} from "@/lib/reach";
import {
  browserReachEnabled,
  fetchXFollowersBatch,
  fetchXFollowersViaBrowser,
} from "@/lib/reach-browser";

type ActionResult = { ok: true } | { ok: false; error: string };

function clean(v?: string) {
  const t = v?.trim();
  return t ? t : null;
}

type FindResult =
  | { ok: true; candidates: GuestSuggestion[] }
  | { ok: false; error: string };

type SaveResult =
  | { ok: true; saved: number; names: string[] }
  | { ok: false; error: string };

// Pull a guest count out of a free-text prompt, e.g.
//   "find 8 guests about AI" -> 8
//   "5 guests about marketing" -> 5
// Falls back to 5 and is clamped to a sane 1–20 range.
function parseCount(text: string): number {
  const match = text.match(/\d+/);
  const n = match ? parseInt(match[0], 10) : NaN;
  if (!Number.isFinite(n)) return 5;
  return Math.min(20, Math.max(1, n));
}

/**
 * Find guest candidates with AI. Does NOT save — returns the raw suggestions so
 * the user can review them in a modal and pick who to add. Accepts either a
 * predefined category id or a free-text topic; the number of guests is taken
 * from the prompt text itself (e.g. "find 8 guests about AI").
 */
export async function findGuests(args: {
  categoryId?: string;
  topic?: string;
}): Promise<FindResult> {
  const { teamId } = await requireMember();

  // Rate-limit the AI call per team to blunt cost/abuse of this expensive,
  // network-heavy action.
  const rl = rateLimit(`findGuests:${teamId}`, 10, 60_000);
  if (!rl.ok) {
    return {
      ok: false,
      error: "Too many requests. Please wait a moment and try again.",
    };
  }

  // Cap free-text topic length before it reaches the model prompt.
  let topic = args.topic?.trim().slice(0, 300);
  const count = parseCount(topic ?? "");
  if (args.categoryId) {
    const category = findCategory(args.categoryId);
    if (!category) return { ok: false, error: "Unknown category" };
    topic = category.topic;
  }
  if (!topic) {
    return { ok: false, error: "Pick a category or enter a topic" };
  }

  let suggestions;
  try {
    suggestions = await suggestGuests(topic, count);
  } catch (e) {
    // Log detail server-side; return a generic message (no internal/AI error
    // text leaked to the client).
    console.error("findGuests: suggestGuests failed:", e);
    return {
      ok: false,
      error: "Could not fetch guests. Check the AI configuration.",
    };
  }

  const candidates = suggestions.filter((s) => s.name?.trim());
  if (candidates.length === 0) {
    return { ok: false, error: "No guests found for this category" };
  }

  return { ok: true, candidates };
}

/**
 * Save the guest candidates the user picked in the review modal. Enriches each
 * one (email scrape + reach) then upserts by name (dedupes / enriches existing
 * rows instead of inserting duplicates).
 */
export async function saveGuests(
  candidates: GuestSuggestion[],
): Promise<SaveResult> {
  const { teamId } = await requireMember();

  const rl = rateLimit(`saveGuests:${teamId}`, 10, 60_000);
  if (!rl.ok) {
    return { ok: false, error: "Too many requests. Please wait a moment." };
  }

  const picked = (candidates ?? []).filter((s) => s?.name?.trim()).slice(0, 50);
  if (picked.length === 0) return { ok: false, error: "No guests selected" };

  const names: string[] = [];
  for (const s of picked) {
    const name = s.name.trim();
    const links = buildLinks([
      s.youtube,
      s.x,
      s.linkedin,
      s.github,
      s.instagram,
      s.website,
    ]);
    const rawEmail = s.email?.trim();
    // Prefer the model's email; otherwise visit the social/website links and
    // scrape a public contact address from them.
    const email = isEmail(rawEmail)
      ? rawEmail!.trim()
      : await findEmailFromSocials(links.split("\n"));
    // Only the AI's per-guest topics — never the search prompt/category label.
    // De-duplicated case-insensitively so topics never repeat.
    const topics = dedupeTopics(s.topics ?? []);
    const reach = await fetchReachFromLinks(links.split("\n"));
    // Dedup by name — enrich an existing guest instead of adding a duplicate row.
    const res = await upsertGuestByName(teamId, {
      name,
      role: clean(s.expertise),
      image: avatarFromLinks(links),
      bio: clean(s.bio),
      email,
      topics: clean(topics),
      context: clean(s.context),
      links: links || null,
      notes: clean(s.whereToFind),
      youtubeSubscribers: reach.youtubeSubscribers,
      xFollowers: reach.xFollowers,
    });
    if (res?.inserted) names.push(name);
  }

  revalidatePath("/guests");
  return { ok: true, saved: names.length, names };
}

// Normalized name key used to group duplicate guests: case-insensitive, trimmed,
// internal whitespace collapsed. Must match the matching rule used at insert time
// (see upsertGuestByName).
function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// Keep the larger of two reach counts (null = unknown).
function maxReach(a?: number | null, b?: number | null): number | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.max(a, b);
}

/**
 * Remove duplicate guests for the current team. Guests are considered duplicates
 * when their names match case-insensitively (after trimming + collapsing
 * whitespace). The oldest row in each group is kept and the others are merged
 * into it (additively, so no field is lost), then the now-redundant rows are
 * deleted. Exactly one row per name always survives.
 */
export async function removeDuplicateGuests(): Promise<
  { ok: true; deleted: number } | { ok: false; error: string }
> {
  const { teamId } = await requireMember();

  const rows = await db
    .select()
    .from(guest)
    .where(eq(guest.teamId, teamId));

  // Group rows by normalized name, oldest first so the keeper is the original.
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = nameKey(r.name);
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }

  const dupeIds: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort(
      (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
    );
    const [keep, ...rest] = group;

    // Merge the duplicates' data into the keeper: existing scalars win, gaps get
    // filled, list-like fields are unioned, reach takes the largest known value.
    await db
      .update(guest)
      .set({
        role: keep.role ?? rest.find((r) => r.role)?.role ?? null,
        image: keep.image ?? rest.find((r) => r.image)?.image ?? null,
        bio: keep.bio ?? rest.find((r) => r.bio)?.bio ?? null,
        email: keep.email ?? rest.find((r) => r.email)?.email ?? null,
        notes: keep.notes ?? rest.find((r) => r.notes)?.notes ?? null,
        topics:
          dedupeTopics(group.flatMap((r) => r.topics?.split(",") ?? [])) ||
          null,
        links:
          buildLinks(group.flatMap((r) => r.links?.split("\n") ?? [])) || null,
        context:
          [...new Set(group.map((r) => r.context?.trim()).filter(Boolean))].join(
            " — ",
          ) || null,
        youtubeSubscribers: group.reduce<number | null>(
          (acc, r) => maxReach(acc, r.youtubeSubscribers),
          null,
        ),
        xFollowers: group.reduce<number | null>(
          (acc, r) => maxReach(acc, r.xFollowers),
          null,
        ),
      })
      .where(eq(guest.id, keep.id));

    dupeIds.push(...rest.map((r) => r.id));
  }

  if (dupeIds.length === 0) return { ok: true, deleted: 0 };

  await db
    .delete(guest)
    .where(and(inArray(guest.id, dupeIds), eq(guest.teamId, teamId)));
  revalidatePath("/guests");
  return { ok: true, deleted: dupeIds.length };
}

export type OffTopicGuestRow = {
  id: string;
  name: string;
  role: string | null;
  reason: string;
};

type ScanOffTopicResult =
  | { ok: true; offTopic: OffTopicGuestRow[] }
  | { ok: false; error: string };

/**
 * Scan saved guests against David's channel context and return the ones whose
 * work doesn't connect to the channel's themes. Does NOT delete — the UI shows
 * them in a modal so the user picks who to remove.
 */
export async function scanOffTopicGuests(): Promise<ScanOffTopicResult> {
  const { teamId } = await requireMember();

  const rl = rateLimit(`scanOffTopicGuests:${teamId}`, 10, 60_000);
  if (!rl.ok) {
    return { ok: false, error: "Too many requests. Please wait a moment." };
  }

  // Need the channel overview to judge against. Without it we can't tell what
  // "on-topic" means, so bail with a clear message rather than guessing.
  const [chan] = await db
    .select({ context: channel.context })
    .from(channel)
    .where(eq(channel.teamId, teamId))
    .limit(1);
  const context = chan?.context?.trim();
  if (!context) {
    return {
      ok: false,
      error: "No channel context yet. Run a channel scan first.",
    };
  }

  const rows = await db
    .select({
      id: guest.id,
      name: guest.name,
      role: guest.role,
      topics: guest.topics,
      bio: guest.bio,
    })
    .from(guest)
    .where(eq(guest.teamId, teamId));
  if (rows.length === 0) return { ok: true, offTopic: [] };

  let offTopic;
  try {
    offTopic = await findOffTopicGuests(context, rows);
  } catch (e) {
    console.error("scanOffTopicGuests: findOffTopicGuests failed:", e);
    return {
      ok: false,
      error: "Could not scan guests. Check the AI configuration.",
    };
  }

  return {
    ok: true,
    offTopic: offTopic.map((o) => ({
      id: rows[o.index].id,
      name: rows[o.index].name,
      role: rows[o.index].role,
      reason: o.reason,
    })),
  };
}

export async function deleteGuest(id: string): Promise<ActionResult> {
  const { teamId } = await requireMember();
  if (!id) return { ok: false, error: "Missing ID" };
  await db.delete(guest).where(and(eq(guest.id, id), eq(guest.teamId, teamId)));
  revalidatePath("/guests");
  return { ok: true };
}

export async function deleteGuests(
  ids: string[],
): Promise<{ ok: true; deleted: number } | { ok: false; error: string }> {
  const { teamId } = await requireMember();
  const clean = (ids ?? []).filter(Boolean);
  if (clean.length === 0) return { ok: false, error: "No guests selected" };
  await db
    .delete(guest)
    .where(and(inArray(guest.id, clean), eq(guest.teamId, teamId)));
  revalidatePath("/guests");
  return { ok: true, deleted: clean.length };
}

// Re-scrape a guest's YouTube/X reach from its links and store the fresh counts.
// Unlike the create-time upsert (which keeps the larger value), refresh overwrites
// with the current truth — but never wipes an existing number when a scrape returns
// null (e.g. X almost always fails, or YouTube transiently blocks the request).
async function rescrapeReach(g: {
  id: string;
  links: string | null;
  youtubeSubscribers: number | null;
  xFollowers: number | null;
}): Promise<boolean> {
  if (!g.links) return false;
  const links = g.links.split("\n");

  // YouTube subscriber counts are public — read them over plain HTTP. X follower
  // counts are hidden behind a JS login wall, so fetch those with the logged-in
  // stealth browser when credentials are configured.
  const http = await fetchReachFromLinks(links);
  let xFollowers = http.xFollowers;
  if (xFollowers == null && browserReachEnabled()) {
    const xUrl = links.map((l) => l.trim()).find(isX);
    if (xUrl) xFollowers = await fetchXFollowersViaBrowser(xUrl);
  }
  const reach = { youtubeSubscribers: http.youtubeSubscribers, xFollowers };

  if (reach.youtubeSubscribers == null && reach.xFollowers == null) return false;
  await db
    .update(guest)
    .set({
      youtubeSubscribers: reach.youtubeSubscribers ?? g.youtubeSubscribers,
      xFollowers: reach.xFollowers ?? g.xFollowers,
    })
    .where(eq(guest.id, g.id));
  return true;
}

export async function refreshGuestReach(id: string): Promise<ActionResult> {
  const { teamId } = await requireMember();
  if (!id) return { ok: false, error: "Missing ID" };
  const [g] = await db
    .select()
    .from(guest)
    .where(and(eq(guest.id, id), eq(guest.teamId, teamId)))
    .limit(1);
  if (!g) return { ok: false, error: "Guest not found" };
  if (!g.links) return { ok: false, error: "Guest has no links to scrape" };
  await rescrapeReach(g);
  revalidatePath("/guests");
  return { ok: true };
}

function firstLink(
  links: string | null,
  match: (u: string) => boolean,
): string | null {
  return (
    links
      ?.split("\n")
      .map((l) => l.trim())
      .find((l) => l && match(l)) ?? null
  );
}

export async function refreshAllReach(): Promise<
  { ok: true; updated: number } | { ok: false; error: string }
> {
  const { teamId } = await requireMember();
  const rl = rateLimit(`refreshAllReach:${teamId}`, 3, 60_000);
  if (!rl.ok) {
    return { ok: false, error: "Too many refreshes. Please wait a moment." };
  }
  const rows = await db.select().from(guest).where(eq(guest.teamId, teamId));

  // Pass 1: YouTube subscribers over plain HTTP, in small batches so we don't
  // fire 100+ parallel requests at YouTube from one IP (which triggers blocks).
  const ytByGuest = new Map<string, number>();
  const BATCH = 5;
  const ytTargets = rows
    .map((g) => ({ id: g.id, url: firstLink(g.links, isYoutube) }))
    .filter((t): t is { id: string; url: string } => Boolean(t.url));
  for (let i = 0; i < ytTargets.length; i += BATCH) {
    const slice = ytTargets.slice(i, i + BATCH);
    const counts = await Promise.all(
      slice.map((t) => fetchYoutubeSubscribers(t.url)),
    );
    slice.forEach((t, j) => {
      const n = counts[j];
      if (n != null) ytByGuest.set(t.id, n);
    });
  }

  // Pass 2: X followers in ONE logged-in browser session (login once, not per guest).
  let xByUrl = new Map<string, number>();
  if (browserReachEnabled()) {
    const xUrls = rows
      .map((g) => firstLink(g.links, isX))
      .filter((u): u is string => Boolean(u));
    xByUrl = await fetchXFollowersBatch(xUrls);
  }

  // Pass 3: persist. Never wipe an existing number when a fresh scrape is missing.
  let updated = 0;
  for (const g of rows) {
    const yt = ytByGuest.get(g.id) ?? null;
    const xUrl = firstLink(g.links, isX);
    const x = xUrl ? xByUrl.get(xUrl) ?? null : null;
    if (yt == null && x == null) continue;
    await db
      .update(guest)
      .set({
        youtubeSubscribers: yt ?? g.youtubeSubscribers,
        xFollowers: x ?? g.xFollowers,
      })
      .where(eq(guest.id, g.id));
    updated++;
  }

  revalidatePath("/guests");
  return { ok: true, updated };
}
