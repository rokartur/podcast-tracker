"use server";

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { channel, channelVideo } from "@/db/schema";
import { requireMember } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeHandle } from "@/lib/youtube";
import { scrapeChannelForTeam } from "@/lib/channel-scrape-core";
import { synthesizeChannelContext } from "@/lib/ai/channel-context";
import {
  DAVID_ONDREJ_HANDLE,
  type ScrapePeriod,
  type ScrapeChannelResult,
} from "@/lib/channel-config";

/**
 * User-triggered scan of David Ondrej's channel for the current team.
 * Thin wrapper around the shared core; the cron job uses the same core.
 */
export async function scrapeDavidOndrejChannel(
  period: ScrapePeriod = "30d",
): Promise<ScrapeChannelResult> {
  const { teamId } = await requireMember();
  const rl = rateLimit(`scrape:${teamId}`, 6, 60_000);
  if (!rl.ok) {
    return { ok: false, error: "Too many scans. Please wait a moment." };
  }
  const res = await scrapeChannelForTeam(teamId, period);
  if (res.ok) {
    revalidatePath("/guests");
    revalidatePath("/channel");
  }
  return res;
}

type RewriteResult =
  | { ok: true; context: string }
  | { ok: false; error: string };

/**
 * Re-synthesise the "What this channel is about" overview from every remembered
 * video. Optional `customPrompt` steers the rewrite (tone, length, focus...).
 */
export async function rewriteChannelContext(
  customPrompt?: string,
): Promise<RewriteResult> {
  const { teamId } = await requireMember();
  const rl = rateLimit(`rewriteContext:${teamId}`, 10, 60_000);
  if (!rl.ok) {
    return { ok: false, error: "Too many requests. Please wait a moment." };
  }
  // Cap the user-supplied steer before it reaches the model prompt.
  const steer = customPrompt?.slice(0, 500);
  const handle = normalizeHandle(DAVID_ONDREJ_HANDLE);

  const channelRow = (
    await db
      .select({ id: channel.id })
      .from(channel)
      .where(and(eq(channel.teamId, teamId), eq(channel.handle, handle)))
      .limit(1)
  )[0];

  if (!channelRow) return { ok: false, error: "No channel memory yet." };

  const videos = await db
    .select({ title: channelVideo.title, summary: channelVideo.summary })
    .from(channelVideo)
    .where(eq(channelVideo.channelId, channelRow.id))
    .orderBy(desc(channelVideo.publishedAt));

  if (videos.length === 0)
    return { ok: false, error: "No remembered videos to summarise." };

  let context: string;
  try {
    context = await synthesizeChannelContext(videos, steer);
  } catch {
    return { ok: false, error: "Rewrite failed. Try again." };
  }

  if (!context) return { ok: false, error: "Got an empty overview." };

  await db
    .update(channel)
    .set({ context })
    .where(eq(channel.id, channelRow.id));

  revalidatePath("/channel");
  return { ok: true, context };
}

type ScheduleResult = { ok: true } | { ok: false; error: string };

/**
 * Save the daily auto-scan schedule for the current team's channel.
 * Creates the channel row if it doesn't exist yet. No period to choose — a
 * daily scan simply picks up the newest videos it hasn't seen yet.
 */
export async function saveChannelSchedule(input: {
  enabled: boolean;
  hour: number;
}): Promise<ScheduleResult> {
  const { teamId } = await requireMember();
  const handle = normalizeHandle(DAVID_ONDREJ_HANDLE);

  // Coerce/clamp client input: enabled to a real boolean, hour to 0–23.
  const enabled = Boolean(input.enabled);
  const rawHour = Number(input.hour);
  const hour = Number.isFinite(rawHour)
    ? Math.min(23, Math.max(0, Math.round(rawHour)))
    : 8;

  const existing = (
    await db
      .select({ id: channel.id })
      .from(channel)
      .where(and(eq(channel.teamId, teamId), eq(channel.handle, handle)))
      .limit(1)
  )[0];

  if (existing) {
    await db
      .update(channel)
      .set({
        scheduleEnabled: enabled,
        scheduleHour: hour,
      })
      .where(eq(channel.id, existing.id));
  } else {
    await db.insert(channel).values({
      id: crypto.randomUUID(),
      teamId,
      handle,
      url: `https://www.youtube.com/${handle}`,
      scheduleEnabled: enabled,
      scheduleHour: hour,
    });
  }

  revalidatePath("/channel");
  return { ok: true };
}
