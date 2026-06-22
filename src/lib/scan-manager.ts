import "server-only";
import {
  scrapeChannelForTeam,
  type ScrapeProgress,
} from "@/lib/channel-scrape-core";
import { type ScrapePeriod } from "@/lib/channel-config";

// ---------------------------------------------------------------------------
// Background scan manager.
//
// A scan can process hundreds of videos and must keep running even if the user
// navigates away or closes the tab. So we run it here, detached from any HTTP
// request, keyed by teamId. The SSE route only *observes* a running scan:
//  - it replays the buffered events so a reconnecting client catches up,
//  - then streams new events live.
//
// State lives in a module-level Map. In dev/HMR we stash it on globalThis so it
// survives reloads. This is per-process (fine for a single-instance app); a
// multi-instance deployment would need a shared store.
// ---------------------------------------------------------------------------

export type ScanEvent =
  | ScrapeProgress
  | { type: "error"; message: string }
  | { type: "finished" }; // terminal marker: the whole job (all batches) ended

type Subscriber = (e: ScanEvent) => void;

type ScanState = {
  running: boolean;
  cancelled: boolean;
  events: ScanEvent[]; // full buffer for replay
  subscribers: Set<Subscriber>;
  totals: { newVideos: number; newGuests: number };
  startedAt: number;
};

const globalForScans = globalThis as unknown as {
  __scanStates?: Map<string, ScanState>;
};
const states: Map<string, ScanState> =
  globalForScans.__scanStates ?? new Map();
globalForScans.__scanStates = states;

function emit(state: ScanState, e: ScanEvent) {
  state.events.push(e);
  // Cap the buffer so a long scan doesn't grow memory without bound; keep the
  // most recent events (the client only needs recent activity + totals).
  if (state.events.length > 600) {
    state.events.splice(0, state.events.length - 600);
  }
  for (const sub of state.subscribers) {
    try {
      sub(e);
    } catch {
      // ignore a broken subscriber
    }
  }
}

/**
 * Start a scan for a team if one isn't already running. Runs detached; returns
 * immediately. The scan auto-continues batch after batch until no new/stale
 * videos remain, so a single call covers the whole back-catalogue.
 */
export function startScan(
  teamId: string,
  period: ScrapePeriod,
  mode: "full" | "backfill" | "force" = "full",
): ScanState {
  const existing = states.get(teamId);
  if (existing?.running) return existing;

  const state: ScanState = {
    running: true,
    cancelled: false,
    events: [],
    subscribers: new Set(),
    totals: { newVideos: 0, newGuests: 0 },
    startedAt: Date.now(),
  };
  states.set(teamId, state);

  // Detached async loop — intentionally not awaited.
  void (async () => {
    try {
      // Keep running batches until one does no work (no new + no backfilled).
      // scrapeChannelForTeam reports `newVideos` as work done this batch.
      // A safety cap prevents a pathological infinite loop.
      for (let batch = 0; batch < 200; batch++) {
        if (state.cancelled) break;
        const res = await scrapeChannelForTeam(
          teamId,
          period,
          25,
          (e) => {
            emit(state, e);
          },
          mode,
        );
        if (!res.ok) {
          emit(state, { type: "error", message: res.error });
          break;
        }
        state.totals.newVideos += res.newVideos;
        state.totals.newGuests += res.newGuests;
        if (res.newVideos === 0) break; // nothing left to do
        if (state.cancelled) break;
      }
    } catch (e) {
      emit(state, {
        type: "error",
        message: e instanceof Error ? e.message : "Scan failed",
      });
    } finally {
      emit(state, { type: "finished" });
      state.running = false;
      // Keep the finished state around briefly so a late reconnect can read the
      // final summary, then drop it.
      setTimeout(() => {
        if (!state.running && states.get(teamId) === state) {
          states.delete(teamId);
        }
      }, 60_000);
    }
  })();

  return state;
}

export function getScan(teamId: string): ScanState | undefined {
  return states.get(teamId);
}

/**
 * Subscribe to a team's scan. Immediately replays buffered events, then streams
 * new ones. Returns an unsubscribe function. Returns null if no scan exists.
 */
export function subscribe(
  teamId: string,
  cb: Subscriber,
): (() => void) | null {
  const state = states.get(teamId);
  if (!state) return null;

  // Replay buffer so a (re)connecting client catches up.
  for (const e of [...state.events]) cb(e);

  // If the scan already finished, there's nothing more to stream.
  if (!state.running) return () => {};

  state.subscribers.add(cb);
  return () => state.subscribers.delete(cb);
}

export function isScanning(teamId: string): boolean {
  return !!states.get(teamId)?.running;
}

/**
 * Request a running scan to stop after the current batch. The detached loop
 * checks this flag between batches.
 */
export function stopScan(teamId: string): boolean {
  const state = states.get(teamId);
  if (state?.running) {
    state.cancelled = true;
    return true;
  }
  return false;
}
