"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  saveChannelSchedule,
  rewriteChannelContext,
} from "@/lib/actions/channel-scrape";
import { type ScrapePeriod } from "@/lib/channel-config";

const field =
  "rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-white/30";

type FeedItem =
  | { kind: "video"; index: number; title: string; url: string }
  | {
      kind: "guest";
      name: string;
      role: string | null;
      image: string | null;
      videoTitle: string;
    };

export function ChannelScrape({ fullScanDone }: { fullScanDone: boolean }) {
  const router = useRouter();
  const [period] = useState<ScrapePeriod>("30d");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [progress, setProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const esRef = useRef<EventSource | null>(null);
  // Reconnect attempt counter for capped exponential backoff (reset on any
  // successful message).
  const reconnectRef = useRef(0);
  // Running totals across all server-side batches (sent on each "done").
  const totalsRef = useRef({ videos: 0, guests: 0 });

  // The scan itself runs detached on the server (scan manager). The client only
  // observes via SSE, so navigating away / closing the tab does NOT stop it.
  // `wantStart` true => ask the server to begin a scan if none is running.
  function connect(
    wantStart: boolean,
    mode: "full" | "backfill" | "force" = "full",
  ) {
    esRef.current?.close();
    const es = new EventSource(
      `/api/channel/scan?period=${encodeURIComponent(period)}${
        wantStart ? "&start=1" : ""
      }${mode !== "full" ? `&mode=${mode}` : ""}`,
    );
    esRef.current = es;

    es.onmessage = (ev) => {
      // A message means the connection is healthy — reset the reconnect backoff.
      reconnectRef.current = 0;
      let e;
      try {
        e = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (e.type) {
        case "idle":
          // No scan running for this team.
          es.close();
          setRunning(false);
          break;
        case "start":
          setRunning(true);
          setError(null);
          setProgress({ done: 0, total: e.willProcess });
          setStatus(
            e.willProcess === 0
              ? "Up to date…"
              : `Processing ${e.willProcess} video${
                  e.willProcess === 1 ? "" : "s"
                } (${e.totalNew} remaining)…`,
          );
          break;
        case "video":
          setRunning(true);
          setProgress((p) => ({ ...p, done: e.index }));
          setStatus(`Analysing: ${e.title}`);
          setFeed((f) =>
            [
              {
                kind: "video" as const,
                index: e.index,
                title: e.title,
                url: e.url,
              },
              ...f,
            ].slice(0, 200),
          );
          break;
        case "guest":
          setFeed((f) =>
            [
              {
                kind: "guest" as const,
                name: e.name,
                role: e.role,
                image: e.image,
                videoTitle: e.videoTitle,
              },
              ...f,
            ].slice(0, 200),
          );
          break;
        case "done":
          // One batch finished; the server auto-continues. Accumulate totals
          // but don't router.refresh() per batch — that re-fetches the whole
          // RSC tree every 25 videos. The single refresh on "finished" is enough
          // (live activity is already shown via the SSE feed below).
          totalsRef.current.videos += e.newVideos;
          totalsRef.current.guests += e.newGuests;
          setStatus("Continuing…");
          break;
        case "finished":
          es.close();
          setRunning(false);
          setStatus("");
          {
            const { videos, guests } = totalsRef.current;
            toast.success(
              videos === 0
                ? "Memory is up to date — no new videos."
                : `Processed ${videos} new video${
                    videos === 1 ? "" : "s"
                  }, added ${guests} guest${guests === 1 ? "" : "s"}.`,
            );
          }
          router.refresh();
          break;
        case "error":
          setError(e.message);
          break;
      }
    };

    es.onerror = () => {
      // Connection dropped (e.g. navigated away then back). The scan keeps
      // running server-side; reconnect with capped exponential backoff so a
      // persistently failing endpoint can't become a reconnect storm.
      es.close();
      const attempt = reconnectRef.current;
      if (attempt >= 6) {
        setStatus("Lost connection. Refresh to resume.");
        return;
      }
      reconnectRef.current = attempt + 1;
      const delay = Math.min(30_000, 1000 * 2 ** attempt);
      setTimeout(() => {
        if (esRef.current === es) connect(false);
      }, delay);
    };
  }

  function run(mode: "full" | "backfill" | "force" = "full") {
    setError(null);
    setFeed([]);
    setProgress({ done: 0, total: 0 });
    reconnectRef.current = 0;
    totalsRef.current = { videos: 0, guests: 0 };
    setRunning(true);
    setStatus(
      mode === "backfill"
        ? "Summarising videos with no summary yet…"
        : mode === "force"
          ? "Force scan: re-enumerating every video (Videos + Shorts + Streams)…"
          : fullScanDone
            ? "Checking the newest uploads…"
            : "Full scan: enumerating David's whole catalogue…",
    );
    connect(true, mode);
  }

  function stop() {
    setStatus("Stopping after the current video…");
    void fetch("/api/channel/scan/stop", { method: "POST" });
  }

  // On mount, reconnect to any scan already running for this team (e.g. started
  // before navigating away).
  useEffect(() => {
    connect(false);
    return () => esRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <button
          onClick={() => run("backfill")}
          disabled={running}
          className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10 disabled:opacity-50"
          title="Re-summarise remembered videos that still have no summary"
        >
          Summarize missing
        </button>
        <button
          onClick={() => run("force")}
          disabled={running}
          className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10 disabled:opacity-50"
          title="Re-enumerate the whole catalogue (Videos + Shorts + Streams) and add anything missing"
        >
          Force scan all videos
        </button>
        {running && (
          <button
            onClick={stop}
            className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10"
          >
            Stop
          </button>
        )}
      </div>

      {running && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-white/60">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
            <span className="truncate">{status || "Working…"}</span>
          </div>
          {progress.total > 0 && (
            <div className="space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full bg-emerald-400 transition-all"
                  style={{
                    width: `${Math.round(
                      (progress.done / progress.total) * 100,
                    )}%`,
                  }}
                />
              </div>
              <p className="text-xs text-white/40">
                {progress.done} / {progress.total} videos
              </p>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {feed.length > 0 && (
        <div className="max-h-80 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.02] p-2">
          {feed.map((item, i) =>
            item.kind === "video" ? (
              <a
                key={`v${item.index}-${i}`}
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-white/70 transition hover:bg-white/5"
              >
                <span className="text-xs text-white/30">#{item.index}</span>
                <span className="text-white/40">🎥</span>
                <span className="truncate">{item.title}</span>
              </a>
            ) : (
              <div
                key={`g${i}`}
                className="flex items-center gap-3 rounded-lg bg-emerald-500/5 px-2 py-1.5"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/10 text-[10px] text-white/60">
                  {item.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.image}
                      alt={item.name}
                      className="h-7 w-7 object-cover"
                      referrerPolicy="no-referrer"
                      onError={(ev) => {
                        ev.currentTarget.style.display = "none";
                      }}
                    />
                  ) : (
                    "👤"
                  )}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-emerald-300">
                    + {item.name}
                    {item.role ? (
                      <span className="font-normal text-white/50">
                        {" "}— {item.role}
                      </span>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-white/30">
                    from {item.videoTitle}
                  </p>
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function ChannelContext({
  initialContext,
}: {
  initialContext: string;
}) {
  const router = useRouter();
  const [context, setContext] = useState(initialContext);
  const [customPrompt, setCustomPrompt] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function rewrite(custom: boolean) {
    setError(null);
    start(async () => {
      const res = await rewriteChannelContext(
        custom ? customPrompt : undefined,
      );
      if (res.ok) {
        setContext(res.context);
        setOpen(false);
        setCustomPrompt("");
        toast.success("Channel context rewritten.");
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-white/70">{context}</p>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          onClick={() => rewrite(false)}
          disabled={pending}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-sm font-medium text-white/80 transition hover:bg-white/10 disabled:opacity-50"
        >
          {pending ? "Rewriting…" : "Rewrite"}
        </button>
        <button
          onClick={() => setOpen((o) => !o)}
          disabled={pending}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-sm font-medium text-white/80 transition hover:bg-white/10 disabled:opacity-50"
        >
          {open ? "Cancel custom" : "Rewrite with prompt"}
        </button>
      </div>

      {open && (
        <div className="space-y-2">
          <textarea
            className={`${field} h-24 w-full resize-y`}
            placeholder="e.g. Make it shorter and punchier, focus on the AI-agent tutorials, write for beginners…"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            disabled={pending}
          />
          <button
            onClick={() => rewrite(true)}
            disabled={pending || !customPrompt.trim()}
            className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-white/90 disabled:opacity-50"
          >
            {pending ? "Rewriting…" : "Apply custom rewrite"}
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

export function ChannelSchedule({
  initialHour,
  lastAutoRunDate,
}: {
  initialHour: number;
  lastAutoRunDate: string | null;
}) {
  const router = useRouter();
  const [hour, setHour] = useState(initialHour);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    setError(null);
    start(async () => {
      // Daily listening is always on — only the hour is configurable.
      const res = await saveChannelSchedule({ enabled: true, hour });
      if (res.ok) {
        toast.success("Schedule saved.");
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-white/80">
        New episodes are checked automatically every day. Choose the hour:
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-white/50">At hour</label>
          <select
            className={field}
            value={hour}
            onChange={(e) => setHour(Number(e.target.value))}
            disabled={pending}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h} className="bg-neutral-900">
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={save}
          disabled={pending}
          className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save schedule"}
        </button>
      </div>

      <p className="text-xs text-white/30">
        Runs once a day at the chosen hour (server time) and picks up the newest
        videos automatically. Last automatic run: {lastAutoRunDate ?? "never"}.
      </p>

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
