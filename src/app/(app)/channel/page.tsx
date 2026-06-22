import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { channel } from "@/db/schema";
import { requireMember } from "@/lib/session";
import { normalizeHandle } from "@/lib/youtube";
import { DAVID_ONDREJ_HANDLE } from "@/lib/channel-config";
import {
  ChannelScrape,
  ChannelSchedule,
  ChannelContext,
} from "./channel-scrape";

function fmtDate(d: Date | null) {
  if (!d) return "—";
  return new Date(d).toISOString().slice(0, 10);
}

export default async function ChannelPage() {
  const { teamId } = await requireMember();
  const handle = normalizeHandle(DAVID_ONDREJ_HANDLE);

  const channelRow = (
    await db
      .select()
      .from(channel)
      .where(and(eq(channel.teamId, teamId), eq(channel.handle, handle)))
      .limit(1)
  )[0];

  return (
    <div className="w-full space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-white">
          {channelRow?.title ?? "David Ondrej"}
        </h1>
        <p className="text-sm text-white/40">
          Dedicated scraper for{" "}
          <a
            href={`https://www.youtube.com/${handle}`}
            target="_blank"
            rel="noreferrer"
            className="text-sky-400/80 hover:text-sky-300"
          >
            youtube.com/{handle}
          </a>{" "}
          — AI agents, autonomous coding & AI startups. Scanning remembers every
          video, so re-runs only pick up new uploads and new people.
        </p>
      </header>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h2 className="mb-4 text-lg font-semibold text-white">Channel memory</h2>
        <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Videos remembered" value={String(channelRow?.videosSeen ?? 0)} />
          <Stat label="People found" value={String(channelRow?.guestsFound ?? 0)} />
          <Stat
            label="Last scanned"
            value={fmtDate(channelRow?.lastScrapedAt ?? null)}
          />
          <Stat
            label="Full scan"
            value={channelRow?.fullScanCompletedAt ? "Done" : "Pending"}
          />
        </div>
        <p className="mb-4 text-xs text-white/40">
          {channelRow?.fullScanCompletedAt
            ? "The full back-catalogue has been scanned once. Scans now check only the newest uploads."
            : "First run does a full scan of David's whole catalogue (hundreds of videos, in batches). After that, scans only check the newest uploads."}
        </p>
        <ChannelScrape fullScanDone={!!channelRow?.fullScanCompletedAt} />
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h2 className="mb-1 text-lg font-semibold text-white">
          Daily auto-scan
        </h2>
        <p className="mb-4 text-sm text-white/40">
          Listen for new episodes automatically — no need to scan by hand.
        </p>
        <ChannelSchedule
          initialHour={channelRow?.scheduleHour ?? 8}
          lastAutoRunDate={channelRow?.lastAutoRunDate ?? null}
        />
      </section>

      {channelRow?.context && (
        <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <h2 className="mb-2 text-lg font-semibold text-white">
            What this channel is about
          </h2>
          <ChannelContext initialContext={channelRow.context} />
        </section>
      )}

    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <p className="text-xs uppercase tracking-wide text-white/40">{label}</p>
      <p className="mt-1 text-xl font-semibold text-white">{value}</p>
    </div>
  );
}
