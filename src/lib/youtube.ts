import "server-only";

// ---------------------------------------------------------------------------
// Minimal, dependency-free YouTube channel reader.
//
// We avoid the official Data API (and its key/quota) by using two public
// endpoints:
//   1. The channel HTML page — to resolve an @handle to a canonical channel id.
//   2. The channel Atom/RSS feed — to list the most recent videos.
//
// The RSS feed only returns the latest ~15 uploads, which is exactly what an
// incremental "memory" scraper needs: we just diff the feed against what we've
// already stored and process whatever is new.
// ---------------------------------------------------------------------------

const UA = "PodcastTrackerBot/1.0 (+https://example.com)";
const TIMEOUT_MS = 10_000;

export type ChannelInfo = {
  channelId: string;
  title: string | null;
  url: string;
};

export type ChannelVideo = {
  videoId: string;
  title: string;
  url: string;
  publishedAt: Date | null;
  description: string;
};

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "en" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`YouTube returned ${res.status} for ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Same as fetchText but returns "" instead of throwing — for best-effort calls.
async function fetchTextSafe(url: string): Promise<string> {
  try {
    return await fetchText(url);
  } catch {
    return "";
  }
}

// Normalise "@DavidOndrej", "DavidOndrej", or a full channel URL to a clean
// "@handle" form.
export function normalizeHandle(input: string): string {
  let h = input.trim();
  // Pull the handle out of a URL if one was pasted.
  const urlMatch = h.match(/youtube\.com\/(@[A-Za-z0-9._-]+)/i);
  if (urlMatch) h = urlMatch[1];
  if (!h.startsWith("@")) h = "@" + h;
  return h;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Resolve a YouTube @handle to its canonical channel id (UC...).
 * Scrapes the public channel page and extracts the id from the embedded JSON
 * or the canonical link tag.
 */
export async function resolveChannel(handle: string): Promise<ChannelInfo> {
  const clean = normalizeHandle(handle);
  const pageUrl = `https://www.youtube.com/${clean}`;
  const html = await fetchText(pageUrl);

  // Several places carry the channel id; try the most reliable first.
  const channelId =
    html.match(/"channelId":"(UC[\w-]{22})"/)?.[1] ??
    html.match(/"externalId":"(UC[\w-]{22})"/)?.[1] ??
    html.match(/channel\/(UC[\w-]{22})/)?.[1] ??
    null;

  if (!channelId) {
    throw new Error(
      `Could not resolve a channel id for "${clean}". The handle may be wrong ` +
        `or YouTube changed its page layout.`,
    );
  }

  const title =
    html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ??
    html.match(/"title":"([^"]+)"/)?.[1] ??
    null;

  return {
    channelId,
    title: title ? decodeEntities(title) : null,
    url: pageUrl,
  };
}

function extractTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? decodeEntities(m[1].trim()) : null;
}

// Pull the playlist id out of a full playlist URL, or pass through a bare id.
export function normalizePlaylistId(input: string): string {
  const m = input.match(/[?&]list=([A-Za-z0-9_-]+)/);
  return (m ? m[1] : input).trim();
}

// Parse a YouTube Atom feed (channel or playlist) into ChannelVideo[].
function parseFeed(xml: string): ChannelVideo[] {
  const entries = xml.split(/<entry>/).slice(1);
  const videos: ChannelVideo[] = [];

  for (const raw of entries) {
    const entry = raw.split(/<\/entry>/)[0];
    const videoId =
      entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] ?? null;
    if (!videoId) continue;

    const title = extractTag(entry, "title") ?? "(untitled)";
    const publishedRaw = entry.match(/<published>([^<]+)<\/published>/)?.[1];
    const description =
      entry.match(
        /<media:description>([\s\S]*?)<\/media:description>/,
      )?.[1] ?? "";

    videos.push({
      videoId,
      title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      publishedAt: publishedRaw ? new Date(publishedRaw) : null,
      description: decodeEntities(description.trim()),
    });
  }

  return videos;
}

/**
 * Fetch the latest videos for a channel id via its public RSS feed.
 * Returns them newest-first (the order YouTube provides). Limited to ~15 by
 * YouTube; for the full catalogue use the InnerTube enumerators below.
 */
export async function fetchChannelVideos(
  channelId: string,
): Promise<ChannelVideo[]> {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  return parseFeed(await fetchText(feedUrl));
}

/**
 * Fetch videos from a public playlist via its RSS feed. Accepts a full
 * playlist URL or a bare playlist id. Limited to ~15 most recent.
 */
export async function fetchPlaylistVideos(
  playlist: string,
): Promise<ChannelVideo[]> {
  const id = normalizePlaylistId(playlist);
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${id}`;
  return parseFeed(await fetchText(feedUrl));
}

// ---------------------------------------------------------------------------
// Full-catalogue enumeration via InnerTube (no API key).
//
// The RSS feeds above only return ~15 latest videos. To see every video in a
// channel or playlist we load the public page (to grab the InnerTube API key
// and the first batch), then page through `continuation` tokens against the
// youtubei browse endpoint — the same mechanism the website itself uses.
// We extract lightweight entries (id + title) and fetch each video's full
// description lazily, only for the new videos we actually process.
// ---------------------------------------------------------------------------

export type VideoStub = { videoId: string; title: string };

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Cookie: "CONSENT=YES+1; SOCS=CAI",
};

async function fetchPage(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`YouTube returned ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Recursively collect every value stored under `key` anywhere in an object.
function collect(obj: unknown, key: string, out: unknown[] = []): unknown[] {
  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    if (rec[key] !== undefined) out.push(rec[key]);
    for (const k in rec) collect(rec[k], key, out);
  }
  return out;
}

// Pull video stubs out of any ytInitialData / browse-continuation blob.
// Handles both the legacy *Renderer shapes and the new lockupViewModel.
function extractStubs(root: unknown): VideoStub[] {
  const stubs: VideoStub[] = [];
  const seen = new Set<string>();

  const push = (videoId?: string, title?: string) => {
    if (!videoId || seen.has(videoId)) return;
    seen.add(videoId);
    stubs.push({ videoId, title: title?.trim() || "(untitled)" });
  };

  // New lockupViewModel shape.
  for (const lv of collect(root, "lockupViewModel") as Record<
    string,
    unknown
  >[]) {
    const videoId = lv?.contentId as string | undefined;
    const meta = (
      (lv?.metadata as Record<string, unknown>)
        ?.lockupMetadataViewModel as Record<string, unknown>
    )?.title as Record<string, unknown> | undefined;
    push(videoId, meta?.content as string | undefined);
  }

  // Shorts tab shape: shortsLockupViewModel. The videoId lives on the reel
  // watch endpoint; the only title available is accessibilityText, which YouTube
  // suffixes with ", N views - play Short" — strip that to recover the title.
  for (const sv of collect(root, "shortsLockupViewModel") as Record<
    string,
    unknown
  >[]) {
    const videoId = (
      (
        (sv?.onTap as Record<string, unknown>)
          ?.innertubeCommand as Record<string, unknown>
      )?.reelWatchEndpoint as Record<string, unknown>
    )?.videoId as string | undefined;
    const title = (sv?.accessibilityText as string | undefined)
      ?.replace(/,\s*[^,]*\bviews?\b.*$/i, "")
      .replace(/\s*-\s*play Short\s*$/i, "")
      .trim();
    push(videoId, title);
  }

  // Legacy renderer shapes.
  for (const name of [
    "playlistVideoRenderer",
    "gridVideoRenderer",
    "videoRenderer",
    "richItemRenderer",
  ]) {
    for (const r of collect(root, name) as Record<string, unknown>[]) {
      const node = (r?.content ?? r) as Record<string, unknown>;
      const inner =
        ((node?.videoRenderer as Record<string, unknown>) ?? node) || {};
      const videoId = inner?.videoId as string | undefined;
      const titleObj = inner?.title as Record<string, unknown> | undefined;
      const runs = titleObj?.runs as { text?: string }[] | undefined;
      const simple = titleObj?.simpleText as string | undefined;
      push(videoId, runs?.[0]?.text ?? simple);
    }
  }

  return stubs;
}

function firstContinuation(root: unknown): string | null {
  const cmds = collect(root, "continuationCommand") as Record<
    string,
    unknown
  >[];
  for (const c of cmds) {
    if (typeof c?.token === "string") return c.token;
  }
  return null;
}

function parseInitialData(html: string): unknown | null {
  const m =
    html.match(/var ytInitialData = (\{[\s\S]+?\});<\/script>/) ??
    html.match(/ytInitialData"\]\s*=\s*(\{[\s\S]+?\});/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function enumerateFromPage(pageUrl: string): Promise<VideoStub[]> {
  const html = await fetchPage(pageUrl);
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const clientVersion =
    html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1] ??
    html.match(/"clientVersion":"([^"]+)"/)?.[1] ??
    "2.20240101";

  const initial = parseInitialData(html);
  const all: VideoStub[] = initial ? extractStubs(initial) : [];
  const seen = new Set(all.map((v) => v.videoId));

  let token = initial ? firstContinuation(initial) : null;
  let pages = 0;
  let prevToken: string | null = null;
  let emptyStreak = 0;
  // Hard cap on pages so a runaway feed can't loop forever (~30 * 150 = 4500).
  // 150 covers very large channels; real catalogues finish far sooner.
  while (token && apiKey && pages < 150) {
    let data: unknown;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/browse?key=${apiKey}&prettyPrint=false`,
        {
          method: "POST",
          headers: { ...BROWSER_HEADERS, "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            context: {
              client: { clientName: "WEB", clientVersion, hl: "en" },
            },
            continuation: token,
          }),
        },
      );
      if (!res.ok) break;
      data = await res.json();
    } catch {
      break;
    } finally {
      clearTimeout(timer);
    }
    const batch = extractStubs(data);
    let added = 0;
    for (const v of batch) {
      if (!seen.has(v.videoId)) {
        seen.add(v.videoId);
        all.push(v);
        added++;
      }
    }
    const next = firstContinuation(data);
    pages++;
    // Some intermediate continuation pages legitimately yield no NEW stubs (a
    // section header, a dup-only page) yet more videos follow. Tolerate a few
    // such pages instead of breaking immediately — but bail if the token stops
    // advancing (a real loop) or several empties run together.
    if (added === 0) {
      if (next === token || next === prevToken || ++emptyStreak >= 3) break;
    } else {
      emptyStreak = 0;
    }
    prevToken = token;
    token = next;
  }

  return all;
}

/**
 * Enumerate EVERY video in a channel's "Videos" tab (not just the RSS latest).
 * Returns lightweight stubs (id + title); fetch descriptions lazily as needed.
 */
export async function fetchAllChannelVideoStubs(
  channelId: string,
): Promise<{ stubs: VideoStub[]; complete: boolean }> {
  // A channel's uploads are split across separate tabs: long-form "Videos",
  // "Shorts" and "Streams"/"Live". The Videos tab alone misses Shorts and past
  // live streams, so enumerate all three and merge (de-duped by videoId).
  //
  // `complete` is false if ANY tab fetch failed. Callers must not treat a
  // partial enumeration as the full catalogue (otherwise a transient failure on
  // one tab silently drops those videos forever).
  const base = `https://www.youtube.com/channel/${channelId}`;
  const results = await Promise.allSettled([
    enumerateFromPage(`${base}/videos?hl=en`),
    enumerateFromPage(`${base}/shorts?hl=en`),
    enumerateFromPage(`${base}/streams?hl=en`),
  ]);
  const complete = results.every((r) => r.status === "fulfilled");
  const merged = new Map<string, VideoStub>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const v of r.value) {
      if (!merged.has(v.videoId)) merged.set(v.videoId, v);
    }
  }
  return { stubs: [...merged.values()], complete };
}

/**
 * Enumerate EVERY video in a public playlist (not just the RSS latest).
 */
export async function fetchAllPlaylistVideoStubs(
  playlist: string,
): Promise<VideoStub[]> {
  const id = normalizePlaylistId(playlist);
  return enumerateFromPage(`https://www.youtube.com/playlist?list=${id}&hl=en`);
}

/**
 * Fetch a single video's description (and published date when present) from its
 * watch page. Best-effort: returns empty fields on failure.
 */
export async function fetchVideoDetails(
  videoId: string,
): Promise<{ description: string; publishedAt: Date | null }> {
  const html = await fetchPage(
    `https://www.youtube.com/watch?v=${videoId}&hl=en`,
  ).catch(() => "");
  if (!html) return { description: "", publishedAt: null };

  // Description lives in the player response as shortDescription (escaped JSON).
  let description = "";
  const m = html.match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
  if (m) {
    try {
      description = JSON.parse(`"${m[1]}"`);
    } catch {
      description = m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
  }

  const dateStr =
    html.match(/"publishDate":"([^"]+)"/)?.[1] ??
    html.match(/"uploadDate":"([^"]+)"/)?.[1] ??
    null;
  const publishedAt = dateStr ? new Date(dateStr) : null;

  return {
    description: description.slice(0, 5000),
    publishedAt:
      publishedAt && !isNaN(publishedAt.getTime()) ? publishedAt : null,
  };
}

// Decode the doubled HTML entities found inside timedtext payloads, e.g.
// "&amp;#39;" -> "'".
function decodeTimedText(s: string): string {
  return decodeEntities(decodeEntities(s));
}

/**
 * Best-effort fetch of a video's caption/transcript text (the "napisy").
 *
 * Scrapes the watch page for the embedded `captionTracks`, picks an English
 * track if available (otherwise the first), downloads the timedtext XML and
 * flattens it to plain text. Returns "" if the video has no usable captions or
 * anything goes wrong — callers should treat captions as optional context.
 *
 * `maxChars` caps the returned text so it stays prompt-friendly.
 */
export async function fetchVideoTranscript(
  videoId: string,
  maxChars = 6000,
): Promise<string> {
  const html = await fetchTextSafe(
    `https://www.youtube.com/watch?v=${videoId}&hl=en`,
  );
  if (!html) return "";

  // The player response embeds caption track metadata as JSON inside the page.
  const m = html.match(/"captionTracks":(\[.*?\])/);
  if (!m) return "";

  let tracks: { baseUrl?: string; languageCode?: string; kind?: string }[];
  try {
    tracks = JSON.parse(m[1].replace(/\\u0026/g, "&"));
  } catch {
    return "";
  }
  if (!Array.isArray(tracks) || tracks.length === 0) return "";

  // Prefer a manual English track, then any English, then anything.
  const pick =
    tracks.find((t) => t.languageCode === "en" && t.kind !== "asr") ??
    tracks.find((t) => t.languageCode === "en") ??
    tracks[0];
  if (!pick?.baseUrl) return "";

  // Try a few formats; YouTube serves different ones and some return empty.
  const base = pick.baseUrl.replace(/&fmt=[^&]*/g, "");
  for (const fmt of ["", "&fmt=srv1", "&fmt=json3"]) {
    const body = await fetchTextSafe(base + fmt);
    if (!body) continue;

    let lines: string[] = [];
    if (fmt === "&fmt=json3") {
      try {
        const data = JSON.parse(body) as {
          events?: { segs?: { utf8?: string }[] }[];
        };
        lines = (data.events ?? [])
          .map((e) => (e.segs ?? []).map((s) => s.utf8 ?? "").join(""))
          .map((l) => l.replace(/\s+/g, " ").trim())
          .filter(Boolean);
      } catch {
        lines = [];
      }
    } else {
      // XML timedtext: a series of <text ...>line</text> entries.
      lines = [...body.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
        .map((mm) => decodeTimedText(mm[1].replace(/<[^>]+>/g, "")).trim())
        .filter(Boolean);
    }

    const text = lines.join(" ").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, maxChars);
  }

  return "";
}
