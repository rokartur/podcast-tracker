import "server-only";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { channel, channelVideo } from "@/db/schema";
import {
  resolveChannel,
  fetchChannelVideos,
  fetchPlaylistVideos,
  fetchAllChannelVideoStubs,
  fetchAllPlaylistVideoStubs,
  fetchVideoDetails,
  fetchVideoTranscript,
  normalizeHandle,
  type ChannelVideo,
} from "@/lib/youtube";
import { extractPeopleFromVideo } from "@/lib/ai/extract-people";
import { synthesizeChannelContext } from "@/lib/ai/channel-context";
import { avatarFromLinks } from "@/lib/avatar";
import {
  buildLinks,
  dedupeTopics,
  extractEmailFromText,
  isEmail,
} from "@/lib/guest-utils";
import { upsertGuestByName } from "@/lib/guest-upsert";
import { findEmailFromSocials } from "@/lib/email-finder";
import { fetchReachFromLinks } from "@/lib/reach";
import {
  DAVID_ONDREJ_HANDLE,
  DAVID_ONDREJ_PLAYLISTS,
  periodDays,
  type ScrapePeriod,
  type ScrapeChannelResult,
} from "@/lib/channel-config";

function clean(v?: string | null) {
  const t = v?.trim();
  return t ? t : null;
}

// Live progress events emitted during a scan so the UI can show work as it
// happens (video discovered, video processed, guest added, done).
export type ScrapeProgress =
  | { type: "start"; totalNew: number; willProcess: number }
  | { type: "video"; index: number; title: string; url: string }
  | {
      type: "guest";
      name: string;
      role: string | null;
      image: string | null;
      videoTitle: string;
    }
  | { type: "video-done"; index: number; peopleFound: number }
  | {
      type: "done";
      newVideos: number;
      newGuests: number;
      totalVideosSeen: number;
    };

export type ProgressFn = (e: ScrapeProgress) => void | Promise<void>;

/**
 * Core scrape logic for one team. Session-agnostic so it can be driven by both
 * the user-triggered server action and the daily cron job. Does NOT call
 * revalidatePath — callers do that if they run inside a request.
 *
 * Behaviour:
 *  - Resolves/creates one `channel` row for this team.
 *  - Enumerates the FULL catalogue (every video in the channel's Videos tab +
 *    configured playlists), merged and de-duplicated by videoId.
 *  - Keeps only videos published within the chosen period.
 *  - Skips any video already in `channel_video` (memory) so each run only
 *    processes genuinely new uploads and nothing is duplicated.
 *  - Processes at most `maxPerRun` new videos per call (newest first) to stay
 *    within time limits; repeated scans / the daily cron gradually cover the
 *    whole back catalogue.
 *  - For each new video, asks the AI for a summary + which real people appear
 *    (excluding David), saving them as guests with context, topics, role, etc.
 *    Repeated guests are allowed.
 *  - Rebuilds the whole-channel context and bumps counters + lastScrapedAt.
 */
export async function scrapeChannelForTeam(
  teamId: string,
  period: ScrapePeriod = "30d",
  maxPerRun = 25,
  onProgress?: ProgressFn,
  // "full": find new uploads + backfill missing summaries (default).
  // "backfill": skip discovery entirely; only (re)summarise remembered videos
  // that still have no "what it's about". Drives the "Summarize missing" button.
  // "force": re-enumerate the ENTIRE catalogue (Videos + Shorts + Streams +
  // playlists) even if the one-off full scan was already marked done — used to
  // pick up videos a previous enumeration missed.
  mode: "full" | "backfill" | "force" = "full",
): Promise<ScrapeChannelResult> {
  const emit = async (e: ScrapeProgress) => {
    if (onProgress) await onProgress(e);
  };
  const handle = normalizeHandle(DAVID_ONDREJ_HANDLE);
  const days = periodDays(period);

  // 1. Find or create the channel memory row.
  let channelRow = (
    await db
      .select()
      .from(channel)
      .where(and(eq(channel.teamId, teamId), eq(channel.handle, handle)))
      .limit(1)
  )[0];

  // 2. Resolve the canonical channel id (also refreshes title on every run).
  let info;
  try {
    info = await resolveChannel(handle);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not reach YouTube",
    };
  }

  if (!channelRow) {
    channelRow = (
      await db
        .insert(channel)
        .values({
          id: crypto.randomUUID(),
          teamId,
          handle,
          youtubeChannelId: info.channelId,
          title: info.title,
          url: info.url,
        })
        .returning()
    )[0];
  } else {
    await db
      .update(channel)
      .set({ youtubeChannelId: info.channelId, title: info.title })
      .where(eq(channel.id, channelRow.id));
  }

  // 3. Build the candidate video set.
  //    - First time (no full scan yet): enumerate the FULL catalogue (every
  //      video in the channel's Videos tab + configured playlists via
  //      InnerTube). This is the one-off "mega scan".
  //    - After the full scan completed: LIGHT mode — only the RSS feeds (newest
  //      ~15 uploads + playlist items), which is fast and enough to catch new
  //      uploads.
  const isFullScanDone = !!channelRow.fullScanCompletedAt;
  const stubs = new Map<string, { title: string }>();
  const rssDates = new Map<string, Date | null>();
  // Backfill-only runs skip discovery entirely — they never touch the feeds and
  // only re-summarise videos already in memory (section 5b below). "force" runs
  // a full enumeration even if the one-off full scan was already completed.
  const enumerateFull = mode === "force" || !isFullScanDone;
  // Becomes false if a full enumeration came back partial (a tab fetch failed),
  // so we never lock in an incomplete catalogue as "fully scanned".
  let enumerationComplete = true;
  // A full enumeration ("force", or the first-time mega scan) means "scan the
  // WHOLE catalogue" — the look-back window doesn't apply, otherwise we'd fetch
  // every video's date only to silently skip nearly all of them (older than the
  // window), leaving progress stuck at 0 while grinding through hundreds of old
  // videos. Light incremental runs keep the period cutoff.
  const cutoff =
    enumerateFull || days === null
      ? null
      : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  if (mode !== "backfill")
  try {
    const [channelRss, playlistRss] = await Promise.all([
      fetchChannelVideos(info.channelId).catch(() => [] as ChannelVideo[]),
      Promise.all(
        DAVID_ONDREJ_PLAYLISTS.map((p) =>
          fetchPlaylistVideos(p).catch(() => [] as ChannelVideo[]),
        ),
      ).then((arrs) => arrs.flat()),
    ]);

    if (enumerateFull) {
      // Full enumeration via InnerTube (slow path, runs until catalogue covered).
      const [channelResult, playlistStubs] = await Promise.all([
        fetchAllChannelVideoStubs(info.channelId).catch(() => ({
          stubs: [] as { videoId: string; title: string }[],
          complete: false,
        })),
        Promise.all(
          DAVID_ONDREJ_PLAYLISTS.map((p) =>
            fetchAllPlaylistVideoStubs(p).catch(() => []),
          ),
        ).then((arrs) => arrs.flat()),
      ]);
      // If any tab/playlist enumeration came back partial, don't mark the full
      // scan complete — the next run will re-enumerate and pick up the rest.
      enumerationComplete = channelResult.complete;
      for (const s of [...channelResult.stubs, ...playlistStubs]) {
        if (!stubs.has(s.videoId)) stubs.set(s.videoId, { title: s.title });
      }
    }

    // RSS provides better titles + real publish dates; prefer them when present.
    for (const v of [...channelRss, ...playlistRss]) {
      stubs.set(v.videoId, { title: v.title });
      rssDates.set(v.videoId, v.publishedAt);
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not read the channel feed",
    };
  }

  if (mode !== "backfill" && stubs.size === 0) {
    return { ok: false, error: "No videos found for this channel" };
  }

  // 4. Figure out which videos are new (not already in memory). Process newest
  //    first and cap per run so we don't time out on 500+ videos — repeated
  //    scans (and the daily cron) gradually cover the whole back catalogue.
  const known = await db
    .select({ videoId: channelVideo.videoId })
    .from(channelVideo)
    .where(eq(channelVideo.channelId, channelRow.id));
  const knownIds = new Set(known.map((k) => k.videoId));

  const newStubs = [...stubs.entries()].filter(([id]) => !knownIds.has(id));

  // Count videos already in memory that still lack a summary (to backfill).
  const staleCount = Number(
    (
      await db
        .select({ c: sql<number>`count(*)` })
        .from(channelVideo)
        .where(
          and(
            eq(channelVideo.channelId, channelRow.id),
            or(isNull(channelVideo.summary), eq(channelVideo.summary, "")),
          ),
        )
    )[0]?.c ?? 0,
  );

  const guestNames: string[] = [];
  let newGuests = 0;
  let processed = 0;

  await emit({
    type: "start",
    totalNew: newStubs.length + staleCount,
    willProcess: Math.min(newStubs.length + staleCount, maxPerRun),
  });

  // 5. Process new videos, fetching details (description + date) lazily.
  for (const [videoId, stub] of newStubs) {
    if (processed >= maxPerRun) break;

    const details = await fetchVideoDetails(videoId).catch(() => ({
      description: "",
      publishedAt: null as Date | null,
    }));
    const publishedAt = rssDates.get(videoId) ?? details.publishedAt;

    // Apply the look-back window (skip silently; not counted as processed).
    if (cutoff && publishedAt && publishedAt < cutoff) continue;

    const video = {
      videoId,
      title: stub.title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      publishedAt,
      description: details.description,
    };
    processed++;
    await emit({
      type: "video",
      index: processed,
      title: video.title,
      url: video.url,
    });

    let summary = "";
    let people: Awaited<ReturnType<typeof extractPeopleFromVideo>>["people"] = [];
    // Best-effort transcript ("napisy") so the AI understands the video more
    // precisely than title + description alone. Empty when unavailable.
    const transcript = await fetchVideoTranscript(video.videoId).catch(() => "");
    try {
      const analysis = await extractPeopleFromVideo({
        title: video.title,
        description: video.description,
        transcript,
        channelContext: channelRow.context ?? "",
      });
      summary = analysis.summary;
      people = analysis.people;
    } catch {
      // If the AI step fails for one video, still record the video so we don't
      // loop on it forever; just with no summary/people detected.
      summary = "";
      people = [];
    }

    // Email mentioned anywhere in the video description (creators often put a
    // business contact there) — a fallback the model can use per person.
    const descEmail = extractEmailFromText(video.description);

    for (const p of people) {
      const name = p.name.trim();
      if (!name) continue;
      const links = buildLinks([
        p.youtube,
        p.x,
        p.linkedin,
        p.github,
        p.instagram,
        p.website,
      ]);
      const context = [
        p.context?.trim() ? p.context.trim() : null,
        `Appeared on David Ondrej's channel in: ${video.title} (${video.url})`,
      ]
        .filter(Boolean)
        .join(" — ");
      const topics = dedupeTopics(p.topics ?? []);
      let email = isEmail(p.email)
        ? p.email.trim()
        : // Only borrow the description email when this video features one guest,
          // so we don't mis-assign a shared contact to the wrong person.
          people.length === 1 && descEmail
          ? descEmail
          : null;
      // Email scrape (last resort) and reach lookup are independent network
      // work — run them concurrently instead of one after the other.
      const linkList = links.split("\n");
      const [scrapedEmail, reach] = await Promise.all([
        email ? Promise.resolve(email) : findEmailFromSocials(linkList),
        fetchReachFromLinks(linkList),
      ]);
      email = scrapedEmail;
      const image = avatarFromLinks(links);
      // Dedup by name across the whole team — re-appearances merge into the
      // existing guest instead of creating duplicate rows.
      const res = await upsertGuestByName(teamId, {
        name,
        role: clean(p.role),
        image,
        bio: clean(p.bio),
        email,
        topics: clean(topics),
        context: clean(context),
        links: links || null,
        notes: clean(`From video: ${video.title}\n${video.url}`),
        youtubeSubscribers: reach.youtubeSubscribers,
        xFollowers: reach.xFollowers,
      });
      if (!res?.inserted) continue;
      guestNames.push(name);
      newGuests++;
      await emit({
        type: "guest",
        name,
        role: clean(p.role),
        image,
        videoTitle: video.title,
      });
    }

    await emit({
      type: "video-done",
      index: processed,
      peopleFound: people.length,
    });

    await db.insert(channelVideo).values({
      id: crypto.randomUUID(),
      teamId,
      channelId: channelRow.id,
      videoId: video.videoId,
      title: video.title,
      url: video.url,
      publishedAt: video.publishedAt,
      summary: clean(summary),
      peopleFound: people.map((p) => p.name.trim()).join(", ") || null,
    });
  }

  // 5b. Backfill: older videos already in memory that have no summary yet (e.g.
  //     remembered before summaries existed, or where the AI step failed).
  //     Re-summarise them using any remaining per-run budget so every video
  //     eventually gets a "what it's about".
  let backfilled = 0;
  if (processed < maxPerRun) {
    const stale = await db
      .select({
        id: channelVideo.id,
        videoId: channelVideo.videoId,
        title: channelVideo.title,
        url: channelVideo.url,
      })
      .from(channelVideo)
      .where(
        and(
          eq(channelVideo.channelId, channelRow.id),
          or(isNull(channelVideo.summary), eq(channelVideo.summary, "")),
        ),
      )
      .orderBy(sql`${channelVideo.publishedAt} DESC NULLS LAST`)
      .limit(maxPerRun - processed);

    for (const row of stale) {
      await emit({
        type: "video",
        index: processed + backfilled + 1,
        title: row.title,
        url: row.url,
      });

      const details = await fetchVideoDetails(row.videoId).catch(() => ({
        description: "",
        publishedAt: null as Date | null,
      }));
      const transcript = await fetchVideoTranscript(row.videoId).catch(
        () => "",
      );

      let summary = "";
      let people: Awaited<
        ReturnType<typeof extractPeopleFromVideo>
      >["people"] = [];
      try {
        const analysis = await extractPeopleFromVideo({
          title: row.title,
          description: details.description,
          transcript,
          channelContext: channelRow.context ?? "",
        });
        summary = analysis.summary;
        people = analysis.people;
      } catch {
        summary = "";
        people = [];
      }

      const descEmail = extractEmailFromText(details.description);

      for (const p of people) {
        const name = p.name.trim();
        if (!name) continue;
        const links = buildLinks([
          p.youtube,
          p.x,
          p.linkedin,
          p.github,
          p.instagram,
          p.website,
        ]);
        const context = [
          p.context?.trim() ? p.context.trim() : null,
          `Appeared on David Ondrej's channel in: ${row.title} (${row.url})`,
        ]
          .filter(Boolean)
          .join(" — ");
        const topics = dedupeTopics(p.topics ?? []);
        let email = isEmail(p.email)
          ? p.email.trim()
          : people.length === 1 && descEmail
            ? descEmail
            : null;
        // Email scrape (last resort) and reach lookup are independent network
        // work — run them concurrently instead of one after the other.
        const linkList = links.split("\n");
        const [scrapedEmail, reach] = await Promise.all([
          email ? Promise.resolve(email) : findEmailFromSocials(linkList),
          fetchReachFromLinks(linkList),
        ]);
        email = scrapedEmail;
        const image = avatarFromLinks(links);
        // Dedup by name across the whole team — re-appearances merge into the
        // existing guest instead of creating duplicate rows.
        const res = await upsertGuestByName(teamId, {
          name,
          role: clean(p.role),
          image,
          bio: clean(p.bio),
          email,
          topics: clean(topics),
          context: clean(context),
          links: links || null,
          notes: clean(`From video: ${row.title}\n${row.url}`),
          youtubeSubscribers: reach.youtubeSubscribers,
          xFollowers: reach.xFollowers,
        });
        if (!res?.inserted) continue;
        guestNames.push(name);
        newGuests++;
        await emit({
          type: "guest",
          name,
          role: clean(p.role),
          image,
          videoTitle: row.title,
        });
      }

      await db
        .update(channelVideo)
        .set({
          // Fall back to the title so the row is no longer "stale" and won't be
          // reprocessed forever when the AI returns nothing.
          summary: clean(summary) ?? row.title,
          peopleFound:
            people.map((p) => p.name.trim()).join(", ") || null,
        })
        .where(eq(channelVideo.id, row.id));

      backfilled++;
      await emit({
        type: "video-done",
        index: processed + backfilled,
        peopleFound: people.length,
      });
    }
  }

  // 6. Rebuild the whole-channel context from every remembered video, so the
  //    understanding of what David's channel is about improves with each scan.
  //    This is an extra full-table read + AI call, so only do it once this run
  //    has caught up (no new/stale videos left to process) instead of after
  //    every batch — during a full back-catalogue scan that's dozens fewer
  //    rebuilds. The scan-manager loops batches until no work remains, so the
  //    final batch always triggers this.
  let channelContext = channelRow.context;
  const moreWorkRemains =
    newStubs.length - processed > 0 || staleCount - backfilled > 0;
  if ((processed > 0 || backfilled > 0) && !moreWorkRemains) {
    const allVideos = await db
      .select({
        title: channelVideo.title,
        summary: channelVideo.summary,
        publishedAt: channelVideo.publishedAt,
      })
      .from(channelVideo)
      .where(eq(channelVideo.channelId, channelRow.id))
      .orderBy(desc(channelVideo.publishedAt));
    try {
      channelContext = await synthesizeChannelContext(allVideos);
    } catch {
      // Keep the previous context if synthesis fails.
    }
  }

  // 7. Update channel memory counters + context. If we're still in full-scan
  //    mode and this batch left nothing new or stale behind, the whole
  //    back-catalogue is covered — mark it done so future scans go light (RSS
  //    only).
  const remainingNew = newStubs.length - processed;
  const remainingStale = staleCount - backfilled;
  const justCompletedFull =
    mode !== "backfill" &&
    !isFullScanDone &&
    enumerationComplete &&
    remainingNew <= 0 &&
    remainingStale <= 0;

  await db
    .update(channel)
    .set({
      lastScrapedAt: new Date(),
      context: channelContext,
      videosSeen: sql`${channel.videosSeen} + ${processed}`,
      guestsFound: sql`${channel.guestsFound} + ${newGuests}`,
      ...(justCompletedFull
        ? { fullScanCompletedAt: new Date() }
        : {}),
    })
    .where(eq(channel.id, channelRow.id));

  const totalVideosSeen = knownIds.size + processed;
  // Report new + backfilled so the client auto-loop keeps going until every
  // remembered video has a summary (backfilled videos aren't "new" but still
  // represent work done this batch).
  const worked = processed + backfilled;

  await emit({
    type: "done",
    newVideos: worked,
    newGuests,
    totalVideosSeen,
  });

  return {
    ok: true,
    newVideos: worked,
    newGuests,
    guestNames,
    totalVideosSeen,
  };
}
