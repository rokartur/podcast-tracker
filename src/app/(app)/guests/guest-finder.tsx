"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { findGuests, saveGuests } from "@/lib/actions/guests";
import type { GuestSuggestion } from "@/lib/ai/suggest";

const field =
  "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 outline-none focus:border-white/30";

export function GuestFinder() {
  const [topic, setTopic] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<GuestSuggestion[] | null>(null);
  const [finding, startFind] = useTransition();

  function run() {
    setError(null);
    setCandidates(null);
    startFind(async () => {
      const res = await findGuests({ topic: topic.trim() || undefined });
      if (res.ok) setCandidates(res.candidates);
      else setError(res.error);
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="text-xs font-medium text-white/50">Prompt</label>
        <input
          className={field}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="e.g. “find 8 guests about career growth in IT”"
          disabled={finding}
        />
        <p className="text-xs text-white/30">
          Include a number to control how many guests — e.g. “10 guests about
          AI”. Defaults to 5.
        </p>
      </div>

      <button
        onClick={run}
        disabled={finding || !topic.trim()}
        className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-white/90 disabled:opacity-50"
      >
        {finding ? "Finding…" : "Find guests"}
      </button>

      {finding && (
        <div className="flex items-center gap-2 text-sm text-white/50">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
          Finding guests…
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {candidates && (
        <GuestPickerModal
          candidates={candidates}
          onClose={() => setCandidates(null)}
          onSaved={(r) => {
            toast.success(
              `Saved ${r.saved} guest${r.saved === 1 ? "" : "s"}.`,
              r.names.length ? { description: r.names.join(", ") } : undefined,
            );
            setCandidates(null);
          }}
        />
      )}
    </div>
  );
}

function GuestPickerModal({
  candidates,
  onClose,
  onSaved,
}: {
  candidates: GuestSuggestion[];
  onClose: () => void;
  onSaved: (r: { saved: number; names: string[] }) => void;
}) {
  // Indices of selected candidates — all selected by default.
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(candidates.map((_, i) => i)),
  );
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  // Filtered candidate indices for the current search query.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const idx = candidates.map((_, i) => i);
    if (!q) return idx;
    return idx.filter((i) => {
      const c = candidates[i];
      return (
        c.name.toLowerCase().includes(q) ||
        (c.expertise ?? "").toLowerCase().includes(q) ||
        (c.bio ?? "").toLowerCase().includes(q) ||
        (c.topics ?? []).some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [candidates, query]);

  function toggle(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  // Select / clear operate on the currently visible (filtered) rows only.
  function selectVisible() {
    setSelected((prev) => new Set([...prev, ...visible]));
  }
  function clearVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const i of visible) next.delete(i);
      return next;
    });
  }

  function save(all: boolean) {
    setError(null);
    const picked = all
      ? candidates
      : candidates.filter((_, i) => selected.has(i));
    if (picked.length === 0) {
      setError("Select at least one guest.");
      return;
    }
    startSave(async () => {
      const res = await saveGuests(picked);
      if (res.ok) onSaved({ saved: res.saved, names: res.names });
      else setError(res.error);
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={saving ? undefined : onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">
              Found {candidates.length} guest
              {candidates.length === 1 ? "" : "s"}
            </h2>
            <p className="text-xs text-white/40">
              {selected.size} selected — pick who to add.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/10 disabled:opacity-50"
          >
            Close
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-5 py-3">
          <input
            className={`${field} flex-1`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, expertise, bio or topic…"
            disabled={saving}
          />
          <button
            onClick={selectVisible}
            disabled={saving || visible.length === 0}
            className="shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-white/80 transition hover:bg-white/10 disabled:opacity-50"
          >
            Select {query.trim() ? "shown" : "all"}
          </button>
          <button
            onClick={clearVisible}
            disabled={saving || visible.length === 0}
            className="shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-white/80 transition hover:bg-white/10 disabled:opacity-50"
          >
            Clear {query.trim() ? "shown" : "all"}
          </button>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-white/40">
              No guests match “{query}”.
            </p>
          ) : null}
          {visible.map((i) => {
            const c = candidates[i];
            const on = selected.has(i);
            return (
              <button
                key={i}
                onClick={() => toggle(i)}
                disabled={saving}
                className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${
                  on
                    ? "border-emerald-500/40 bg-emerald-500/[0.06]"
                    : "border-white/10 bg-white/[0.02] hover:bg-white/5"
                }`}
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs ${
                    on
                      ? "border-emerald-400 bg-emerald-400 text-black"
                      : "border-white/20 text-transparent"
                  }`}
                >
                  ✓
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white">
                    {c.name}
                    {c.expertise ? (
                      <span className="font-normal text-white/50">
                        {" "}— {c.expertise}
                      </span>
                    ) : null}
                  </p>
                  {c.bio ? (
                    <p className="mt-0.5 line-clamp-2 text-xs text-white/50">
                      {c.bio}
                    </p>
                  ) : null}
                  {c.topics?.length ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.topics.slice(0, 5).map((t, ti) => (
                        <span
                          key={ti}
                          className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/60"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>

        {error && (
          <p className="px-5 pb-1 text-sm text-red-400">{error}</p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-5 py-4">
          <button
            onClick={() => save(false)}
            disabled={saving || selected.size === 0}
            className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-white/90 disabled:opacity-50"
          >
            {saving ? "Saving…" : `Add selected (${selected.size})`}
          </button>
          <button
            onClick={() => save(true)}
            disabled={saving}
            className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Add all"}
          </button>
        </div>
      </div>
    </div>
  );
}
