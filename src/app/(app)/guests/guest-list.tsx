"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  deleteGuest,
  deleteGuests,
  refreshAllReach,
  refreshGuestReach,
  removeDuplicateGuests,
  scanOffTopicGuests,
  type OffTopicGuestRow,
} from "@/lib/actions/guests";
import { guestsToMarkdown, guestSection } from "@/lib/guest-markdown";
import { safeLinkHref } from "@/lib/url-safety";

export type GuestCard = {
  id: string;
  name: string;
  role: string | null;
  image: string | null;
  bio: string | null;
  email: string | null;
  topics: string | null;
  context: string | null;
  links: string | null;
  youtubeSubscribers: number | null;
  xFollowers: number | null;
};

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

// Avatar served from our own /api/avatar/[guestId] endpoint, which caches the
// image as binary in the DB and always returns an image (cached bytes → live
// fetch → initials SVG). This removes the blank avatars caused by the browser
// hammering a rate-limited upstream host. Initials remain a last-resort fallback
// for the rare case the request itself fails (e.g. offline/401).
function AvatarImg({ guest }: { guest: GuestCard }) {
  const [failed, setFailed] = useState(false);

  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/10 text-xs font-medium text-white/60">
      {!failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/avatar/${guest.id}`}
          alt={guest.name}
          width={36}
          height={36}
          className="h-9 w-9 object-cover"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        initialsOf(guest.name)
      )}
    </span>
  );
}

// Compact audience count, e.g. 1234567 -> "1.2M".
function formatReach(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

const input =
  "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 outline-none focus:border-white/30";
const select =
  "rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-white/30";

function splitTopics(t: string | null) {
  return (t ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Score a guest against a lowercased search term. Higher = better match.
// Name matches dominate so "sam altman" surfaces the person, not a guest
// whose bio happens to mention him. 0 means no match (filtered out).
function relevanceScore(g: GuestCard, term: string): number {
  if (!term) return 0;
  const name = g.name.toLowerCase();
  let score = 0;

  // Name tiers — exact > prefix > word-prefix > substring.
  if (name === term) score += 1000;
  else if (name.startsWith(term)) score += 500;
  else if (name.split(/\s+/).some((w) => w.startsWith(term))) score += 300;
  else if (name.includes(term)) score += 150;

  // All search terms present somewhere in the name (handles "altman sam",
  // partial first/last name typing).
  const words = term.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => name.includes(w))) score += 200;

  // Secondary fields — weak signal, only matters as a tiebreaker.
  if ((g.role ?? "").toLowerCase().includes(term)) score += 40;
  if ((g.topics ?? "").toLowerCase().includes(term)) score += 30;
  if ((g.context ?? "").toLowerCase().includes(term)) score += 10;
  if ((g.bio ?? "").toLowerCase().includes(term)) score += 10;
  if ((g.email ?? "").toLowerCase().includes(term)) score += 10;
  if ((g.links ?? "").toLowerCase().includes(term)) score += 5;

  return score;
}

function splitLinks(l: string | null) {
  return (l ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    // Drop anything that isn't a safe http/https/mailto link before it can be
    // rendered as an <a href> (guards stored `javascript:`/`data:` URLs).
    .filter((s) => safeLinkHref(s) !== null);
}

// Collapse links that point at the same place. twitter.com and x.com are the
// same account, so a guest with both should show only one badge — keeping the
// first occurrence.
function dedupeLinks(links: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of links) {
    let key = l.toLowerCase();
    try {
      const u = new URL(l);
      let host = u.hostname.replace(/^www\./, "").toLowerCase();
      if (host === "twitter.com" || host.endsWith(".twitter.com")) host = "x.com";
      key = host + u.pathname.replace(/\/+$/, "").toLowerCase();
    } catch {
      // Not a URL — fall back to the raw string.
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

function linkLabel(url: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("youtube") || host.includes("youtu.be")) return "YouTube";
    if (host === "x.com" || host.includes("twitter")) return "X";
    if (host.includes("linkedin")) return "LinkedIn";
    if (host.includes("instagram")) return "Instagram";
    if (host.includes("github")) return "GitHub";
    return host;
  } catch {
    return url;
  }
}

function CopyButton({ guest }: { guest: GuestCard }) {
  async function copy() {
    const md = guestSection(guest);
    try {
      await navigator.clipboard.writeText(md);
      toast.success("Markdown copied.");
    } catch {
      // Clipboard API can be blocked (e.g. non-secure context); ignore.
    }
  }

  return (
    <button
      onClick={copy}
      className="shrink-0 rounded-md px-2 py-1 text-xs text-white/40 transition hover:bg-white/10 hover:text-white/80"
    >
      Copy MD
    </button>
  );
}

function RefreshButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    setError(null);
    start(async () => {
      const res = await refreshGuestReach(id);
      if (res.ok) toast.success("Numbers refreshed.");
      else setError(res.error);
    });
  }

  return (
    <button
      onClick={refresh}
      disabled={pending}
      title="Refresh YouTube/X numbers"
      className="shrink-0 rounded-md px-2 py-1 text-xs text-white/40 transition hover:bg-white/10 hover:text-white/80 disabled:opacity-50"
    >
      {pending ? "…" : "↻"}
      {error && <span className="ml-1 text-red-400">!</span>}
    </button>
  );
}

function DeleteButton({ id, name }: { id: string; name: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function remove() {
    if (!confirm(`Delete guest “${name}”?`)) return;
    setError(null);
    start(async () => {
      const res = await deleteGuest(id);
      if (res.ok) toast.success(`Deleted “${name}”.`);
      else setError(res.error);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={remove}
        disabled={pending}
        className="shrink-0 rounded-md px-2 py-1 text-xs text-white/40 transition hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
      >
        {pending ? "…" : "Delete"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}

// Searchable multi-select for topics. No UI lib in this project, so it's a
// plain button + absolutely-positioned panel with a search box and a checkbox
// list. Closes on outside click or Escape.
function TopicMultiSelect({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selectedSet = new Set(selected.map((s) => s.toLowerCase()));
  const q = query.trim().toLowerCase();
  const visible = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;

  function toggle(topic: string) {
    const key = topic.toLowerCase();
    if (selectedSet.has(key)) {
      onChange(selected.filter((s) => s.toLowerCase() !== key));
    } else {
      onChange([...selected, topic]);
    }
  }

  const label =
    selected.length === 0
      ? "All topics"
      : selected.length === 1
        ? selected[0]
        : `${selected.length} topics`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${select} flex min-w-[10rem] items-center justify-between gap-2`}
      >
        <span className={selected.length === 0 ? "text-white/50" : "text-white"}>
          {label}
        </span>
        <span className="text-white/30">▾</span>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-64 rounded-lg border border-white/10 bg-neutral-900 p-2 shadow-2xl">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search topics…"
            className="mb-2 w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white placeholder:text-white/30 outline-none focus:border-white/30"
          />
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mb-1 w-full rounded-md px-2 py-1 text-left text-xs text-white/50 transition hover:bg-white/10 hover:text-white/80"
            >
              Clear {selected.length} selected
            </button>
          )}
          <div className="max-h-60 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-white/30">
                No topics found
              </p>
            ) : (
              visible.map((t) => {
                const on = selectedSet.has(t.toLowerCase());
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggle(t)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white/80 transition hover:bg-white/10"
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                        on
                          ? "border-white bg-white text-black"
                          : "border-white/25 text-transparent"
                      }`}
                    >
                      ✓
                    </span>
                    <span className="truncate">{t}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type ContactFilter = "all" | "email" | "links" | "none";

const CONTACT_FILTERS: ContactFilter[] = ["all", "email", "links", "none"];

// Everything about the table view we want to survive a page reload: search
// text, topic multi-select, contact filter and column sort. Selection is
// intentionally left out — those row ids go stale as the guest list changes.
type TablePrefs = {
  globalFilter: string;
  topicFilters: string[];
  contactFilter: ContactFilter;
  sorting: SortingState;
};

const PREFS_KEY = "guests-table-prefs:v1";

export function GuestList({ guests }: { guests: GuestCard[] }) {
  const [globalFilter, setGlobalFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [topicFilters, setTopicFilters] = useState<string[]>([]);
  const [contactFilter, setContactFilter] = useState<ContactFilter>("all");
  // Guards the persist effect from writing defaults over stored prefs before
  // the hydrate effect has had a chance to read localStorage on mount.
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [bulkPending, startBulk] = useTransition();
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [refreshPending, startRefresh] = useTransition();
  const [dedupePending, startDedupe] = useTransition();
  const [scanPending, startScan] = useTransition();
  const [offTopic, setOffTopic] = useState<OffTopicGuestRow[] | null>(null);

  function scanOffTopic() {
    setOffTopic(null);
    startScan(async () => {
      const res = await scanOffTopicGuests();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.offTopic.length === 0) {
        toast.success("All guests fit the channel — nothing to remove.");
        return;
      }
      setOffTopic(res.offTopic);
    });
  }

  function refreshAll() {
    startRefresh(async () => {
      const res = await refreshAllReach();
      if (res.ok) toast.success(`Updated ${res.updated} guest(s).`);
      else toast.error(res.error);
    });
  }

  function dedupe() {
    if (!confirm("Remove duplicate guests (same name)? Keeps the oldest.")) return;
    startDedupe(async () => {
      const res = await removeDuplicateGuests();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        res.deleted === 0
          ? "No duplicates found."
          : `Removed ${res.deleted} duplicate${res.deleted === 1 ? "" : "s"}.`,
      );
    });
  }

  // Hydrate filters/sort from localStorage once on mount. Done in an effect
  // (not a lazy useState initializer) so server and first client render agree
  // on the defaults — no hydration mismatch — then we snap to the stored view.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<TablePrefs>;
        if (typeof p.globalFilter === "string") setGlobalFilter(p.globalFilter);
        if (Array.isArray(p.topicFilters))
          setTopicFilters(p.topicFilters.filter((t) => typeof t === "string"));
        if (p.contactFilter && CONTACT_FILTERS.includes(p.contactFilter))
          setContactFilter(p.contactFilter);
        if (Array.isArray(p.sorting)) setSorting(p.sorting as SortingState);
      }
    } catch {
      // Corrupt/blocked storage — fall back to defaults.
    }
    setPrefsLoaded(true);
  }, []);

  // Persist on every change once hydrated.
  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      const prefs: TablePrefs = {
        globalFilter,
        topicFilters,
        contactFilter,
        sorting,
      };
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Storage full/blocked — ignore, the view still works in-memory.
    }
  }, [prefsLoaded, globalFilter, topicFilters, contactFilter, sorting]);

  const hasActivePrefs =
    globalFilter !== "" ||
    topicFilters.length > 0 ||
    contactFilter !== "all" ||
    sorting.length > 0;

  function resetTable() {
    setGlobalFilter("");
    setTopicFilters([]);
    setContactFilter("all");
    setSorting([]);
    setRowSelection({});
    try {
      localStorage.removeItem(PREFS_KEY);
    } catch {
      // Ignore — state is already reset in memory.
    }
  }

  // All distinct topics, for the topic dropdown.
  const allTopics = useMemo(() => {
    const set = new Set<string>();
    for (const g of guests) for (const t of splitTopics(g.topics)) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [guests]);

  const columns = useMemo<ColumnDef<GuestCard>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        header: ({ table }) => (
          <input
            type="checkbox"
            className="h-4 w-4 accent-white"
            checked={table.getIsAllRowsSelected()}
            ref={(el) => {
              if (el) el.indeterminate = table.getIsSomeRowsSelected();
            }}
            onChange={table.getToggleAllRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            className="h-4 w-4 accent-white"
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
      },
      {
        accessorKey: "name",
        header: "Name",
        cell: (info) => {
          const g = info.row.original;
          return (
            <div className="flex items-center gap-3">
              <AvatarImg guest={g} />
              <span className="font-medium text-white">{g.name}</span>
            </div>
          );
        },
      },
      {
        accessorKey: "role",
        header: "What they do",
        enableSorting: true,
        cell: (info) => {
          const role = info.getValue<string | null>();
          return role ? (
            <span className="text-sm text-white/70">{role}</span>
          ) : (
            <span className="text-white/20">—</span>
          );
        },
      },
      {
        accessorKey: "topics",
        header: "Topics",
        enableSorting: false,
        cell: (info) => {
          const topics = splitTopics(info.getValue<string | null>());
          if (topics.length === 0)
            return <span className="text-white/20">—</span>;
          return (
            <div className="flex flex-wrap gap-1">
              {topics.map((t, i) => (
                <span
                  key={i}
                  className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/60"
                >
                  {t}
                </span>
              ))}
            </div>
          );
        },
      },
      {
        accessorKey: "bio",
        header: "Bio",
        enableSorting: false,
        cell: (info) => {
          const bio = info.getValue<string | null>();
          return bio ? (
            <p className="line-clamp-3 max-w-md text-sm text-white/70">{bio}</p>
          ) : (
            <span className="text-white/20">—</span>
          );
        },
      },
      {
        accessorKey: "context",
        header: "Context",
        enableSorting: false,
        cell: (info) => {
          const ctx = info.getValue<string | null>();
          return ctx ? (
            <p className="line-clamp-3 max-w-md text-sm text-white/60">{ctx}</p>
          ) : (
            <span className="text-white/20">—</span>
          );
        },
      },
      {
        accessorKey: "email",
        header: "Email",
        cell: (info) => {
          const email = info.getValue<string | null>();
          return email ? (
            <a
              href={`mailto:${email}`}
              className="text-sm text-white/60 hover:text-white"
            >
              {email}
            </a>
          ) : (
            <span className="text-white/20">—</span>
          );
        },
      },
      {
        accessorKey: "links",
        header: "Links",
        enableSorting: false,
        cell: (info) => {
          const links = dedupeLinks(splitLinks(info.getValue<string | null>()));
          if (links.length === 0)
            return <span className="text-white/20">—</span>;
          return (
            <div className="flex flex-wrap gap-2">
              {links.map((l, i) => (
                <a
                  key={i}
                  href={l}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md bg-white/5 px-2 py-0.5 text-xs text-sky-400/80 hover:text-sky-300"
                >
                  {linkLabel(l)}
                </a>
              ))}
            </div>
          );
        },
      },
      {
        id: "youtubeSubscribers",
        accessorFn: (g) => g.youtubeSubscribers ?? undefined,
        header: "YouTube",
        sortUndefined: "last",
        sortDescFirst: true,
        cell: (info) => {
          const n = info.getValue<number | undefined>();
          return n == null ? (
            <span className="text-white/20">—</span>
          ) : (
            <span className="text-sm tabular-nums text-white/70">
              ▶ {formatReach(n)}
            </span>
          );
        },
      },
      {
        id: "xFollowers",
        accessorFn: (g) => g.xFollowers ?? undefined,
        header: "X",
        sortUndefined: "last",
        sortDescFirst: true,
        cell: (info) => {
          const n = info.getValue<number | undefined>();
          return n == null ? (
            <span className="text-white/20">—</span>
          ) : (
            <span className="text-sm tabular-nums text-white/70">
              𝕏 {formatReach(n)}
            </span>
          );
        },
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: (info) => (
          <div className="flex items-center justify-end gap-1">
            <RefreshButton id={info.row.original.id} />
            <CopyButton guest={info.row.original} />
            <DeleteButton
              id={info.row.original.id}
              name={info.row.original.name}
            />
          </div>
        ),
      },
    ],
    [],
  );

  // Filter the rows ourselves rather than leaning on TanStack's global filter.
  // It's explicit, easy to reason about, and avoids the column-by-column
  // quirks of the built-in global filter (which only searches columns whose
  // first-row value is a string).
  const filtered = useMemo(() => {
    const term = globalFilter.trim().toLowerCase();
    const passed = guests.filter((g) => {
      const textOk = !term || relevanceScore(g, term) > 0;
      if (!textOk) return false;

      // Topic filter — match guests carrying ANY of the selected topics.
      if (topicFilters.length > 0) {
        const topics = splitTopics(g.topics).map((t) => t.toLowerCase());
        const wanted = topicFilters.map((t) => t.toLowerCase());
        if (!wanted.some((w) => topics.includes(w))) return false;
      }

      // Contact filter.
      const hasEmail = !!g.email?.trim();
      const hasLinks = splitLinks(g.links).length > 0;
      if (contactFilter === "email" && !hasEmail) return false;
      if (contactFilter === "links" && !hasLinks) return false;
      if (contactFilter === "none" && (hasEmail || hasLinks)) return false;

      return true;
    });

    // Rank by relevance when searching and the user hasn't picked a column
    // sort. TanStack preserves input order while `sorting` is empty, so
    // pre-sorting here puts the best name matches on top.
    if (term && sorting.length === 0) {
      return passed
        .map((g) => ({ g, score: relevanceScore(g, term) }))
        .sort((a, b) => b.score - a.score || a.g.name.localeCompare(b.g.name))
        .map((x) => x.g);
    }
    return passed;
  }, [guests, globalFilter, topicFilters, contactFilter, sorting]);

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: true,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  function downloadMarkdown(subset?: GuestCard[]) {
    const data = subset ?? filtered;
    if (data.length === 0) return;
    const md = guestsToMarkdown(data);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `guests-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportSelected() {
    const picked = table
      .getSelectedRowModel()
      .rows.map((r) => r.original);
    downloadMarkdown(picked);
  }

  const selectedIds = Object.keys(rowSelection).filter((id) => rowSelection[id]);

  function bulkDelete() {
    if (selectedIds.length === 0) return;
    if (
      !confirm(
        `Delete ${selectedIds.length} selected guest${
          selectedIds.length === 1 ? "" : "s"
        }?`,
      )
    )
      return;
    setBulkError(null);
    startBulk(async () => {
      const count = selectedIds.length;
      const res = await deleteGuests(selectedIds);
      if (res.ok) {
        setRowSelection({});
        toast.success(`Deleted ${count} guest${count === 1 ? "" : "s"}.`);
      } else setBulkError(res.error);
    });
  }

  const rows = table.getRowModel().rows;
  const filteredCount = filtered.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <input
          className={input}
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          placeholder="Search name, role, topic, bio or email…"
        />
        <TopicMultiSelect
          options={allTopics}
          selected={topicFilters}
          onChange={setTopicFilters}
        />
        <select
          className={select}
          value={contactFilter}
          onChange={(e) => setContactFilter(e.target.value as ContactFilter)}
        >
          <option value="all" className="bg-neutral-900">
            Any contact
          </option>
          <option value="email" className="bg-neutral-900">
            Has email
          </option>
          <option value="links" className="bg-neutral-900">
            Has links
          </option>
          <option value="none" className="bg-neutral-900">
            No contact
          </option>
        </select>
        <button
          type="button"
          onClick={resetTable}
          disabled={!hasActivePrefs}
          title="Clear filters, sorting and saved table settings"
          className="shrink-0 rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50"
        >
          ✕ Reset
        </button>
        <button
          type="button"
          onClick={() => downloadMarkdown()}
          disabled={filteredCount === 0}
          className="shrink-0 rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50"
        >
          ⬇ Export Markdown
        </button>
        <button
          type="button"
          onClick={refreshAll}
          disabled={refreshPending}
          title="Re-scrape YouTube/X numbers for every guest"
          className="shrink-0 rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50"
        >
          {refreshPending ? "Refreshing…" : "↻ Refresh numbers"}
        </button>
        <button
          type="button"
          onClick={dedupe}
          disabled={dedupePending || guests.length === 0}
          title="Delete guests with the same name, keeping the oldest"
          className="shrink-0 rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50"
        >
          {dedupePending ? "Removing…" : "⧉ Remove duplicates"}
        </button>
        <button
          type="button"
          onClick={scanOffTopic}
          disabled={scanPending || guests.length === 0}
          title="Find guests that don't fit David's channel themes"
          className="shrink-0 rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-50"
        >
          {scanPending ? "Scanning…" : "✦ Find off-topic"}
        </button>
      </div>

      {offTopic && (
        <OffTopicModal
          rows={offTopic}
          onClose={() => setOffTopic(null)}
          onDeleted={(n) => {
            setOffTopic(null);
            setRowSelection({});
            toast.success(
              `Removed ${n} off-topic guest${n === 1 ? "" : "s"}.`,
            );
          }}
        />
      )}

      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-2">
          <span className="text-sm text-white/70">
            {selectedIds.length} selected
          </span>
          <button
            onClick={exportSelected}
            className="rounded-md bg-white/10 px-3 py-1.5 text-xs font-medium text-white/80 transition hover:bg-white/20"
          >
            ⬇ Export selected
          </button>
          <button
            onClick={bulkDelete}
            disabled={bulkPending}
            className="rounded-md bg-red-500/15 px-3 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-500/25 disabled:opacity-50"
          >
            {bulkPending ? "Deleting…" : "Delete selected"}
          </button>
          <button
            onClick={() => setRowSelection({})}
            className="text-xs text-white/40 transition hover:text-white/70"
          >
            Clear selection
          </button>
          {bulkError && <span className="text-xs text-red-400">{bulkError}</span>}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-white/40">
          {guests.length === 0
            ? "You don't have any guests yet. Find your first ones above."
            : "No guests match your filters."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full border-collapse text-left">
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="border-b border-white/10 bg-white/5">
                  {hg.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
                    return (
                      <th
                        key={header.id}
                        className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-white/50"
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            onClick={header.column.getToggleSortingHandler()}
                            className="flex items-center gap-1 transition hover:text-white/80"
                          >
                            {flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                            <span className="text-white/30">
                              {sorted === "asc"
                                ? "▲"
                                : sorted === "desc"
                                  ? "▼"
                                  : "↕"}
                            </span>
                          </button>
                        ) : (
                          flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={`border-b border-white/5 transition last:border-0 hover:bg-white/[0.03] ${
                    row.getIsSelected() ? "bg-white/[0.04]" : ""
                  }`}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3 align-top">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-white/30">
        {filteredCount} of {guests.length} guest{guests.length === 1 ? "" : "s"}
        {selectedIds.length > 0 ? ` · ${selectedIds.length} selected` : ""}
      </p>
    </div>
  );
}

// Modal listing guests the AI judged off-topic for the channel. All selected by
// default; the user unticks any to keep, then deletes the rest.
function OffTopicModal({
  rows,
  onClose,
  onDeleted,
}: {
  rows: OffTopicGuestRow[];
  onClose: () => void;
  onDeleted: (deleted: number) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(rows.map((r) => r.id)),
  );
  const [error, setError] = useState<string | null>(null);
  const [deleting, startDelete] = useTransition();

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function remove() {
    const ids = rows.map((r) => r.id).filter((id) => selected.has(id));
    if (ids.length === 0) {
      setError("Select at least one guest to remove.");
      return;
    }
    setError(null);
    startDelete(async () => {
      const res = await deleteGuests(ids);
      if (res.ok) onDeleted(res.deleted);
      else setError(res.error);
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={deleting ? undefined : onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">
              {rows.length} off-topic guest{rows.length === 1 ? "" : "s"}
            </h2>
            <p className="text-xs text-white/40">
              {selected.size} selected — these don&apos;t fit the channel. Pick
              who to remove.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={deleting}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/10 disabled:opacity-50"
          >
            Close
          </button>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {rows.map((r) => {
            const on = selected.has(r.id);
            return (
              <button
                key={r.id}
                onClick={() => toggle(r.id)}
                disabled={deleting}
                className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${
                  on
                    ? "border-red-500/40 bg-red-500/[0.06]"
                    : "border-white/10 bg-white/[0.02] hover:bg-white/5"
                }`}
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs ${
                    on
                      ? "border-red-400 bg-red-400 text-black"
                      : "border-white/20 text-transparent"
                  }`}
                >
                  ✓
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white">
                    {r.name}
                    {r.role ? (
                      <span className="font-normal text-white/50"> — {r.role}</span>
                    ) : null}
                  </p>
                  {r.reason ? (
                    <p className="mt-0.5 text-xs text-white/50">{r.reason}</p>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>

        {error && <p className="px-5 pb-1 text-sm text-red-400">{error}</p>}

        <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-5 py-4">
          <button
            onClick={remove}
            disabled={deleting || selected.size === 0}
            className="rounded-lg bg-red-500/90 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-500 disabled:opacity-50"
          >
            {deleting ? "Removing…" : `Delete selected (${selected.size})`}
          </button>
          <button
            onClick={onClose}
            disabled={deleting}
            className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
