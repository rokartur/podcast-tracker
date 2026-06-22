import "server-only";
import { llmJson } from "@/lib/ai/provider";

// One guest fed to the relevance judge. Index is the position in the input list;
// the model returns indices so we never depend on it echoing names back exactly.
export type GuestForJudge = {
  name: string;
  role?: string | null;
  topics?: string | null;
  bio?: string | null;
};

export type OffTopicGuest = { index: number; reason: string };

const SCHEMA = {
  type: "object",
  properties: {
    offTopic: {
      type: "array",
      description:
        "The guests whose work/expertise does NOT connect to the channel's " +
        "themes. Only include clear mismatches.",
      items: {
        type: "object",
        properties: {
          index: {
            type: "number",
            description: "The 0-based index of the off-topic guest in the list.",
          },
          reason: {
            type: "string",
            description:
              "One short sentence: why this guest does not fit the channel.",
          },
        },
        required: ["index", "reason"],
      },
    },
  },
  required: ["offTopic"],
} as const;

const CAVEMAN = [
  "CAVEMAN RULES (follow exactly):",
  "- Judge guest by their OWN real expertise/work/field vs CHANNEL CONTEXT themes.",
  "- Guest field clearly match channel theme -> KEEP (do not list).",
  "- Guest field is different world (entertainment, sports, generic vlogging, lifestyle, music, comedy, MrBeast-type creators) with no tie to channel topic -> off-topic. LIST them.",
  "- Use your own knowledge of who the person is, not just text given.",
  "- Famous != relevant. Big creator from unrelated field still off-topic.",
  "- Real doubt only -> KEEP. But do not excuse clear mismatch.",
  "- reason = one short sentence: their field vs channel. English. True.",
].join("\n");

const SYSTEM =
  "You curate a podcast guest list for a specific YouTube channel. You are " +
  "given the channel's overview and a numbered list of saved guests. Decide " +
  "which guests do NOT belong because THEIR OWN expertise/field has no real " +
  "connection to what the channel is about. Judge each person by who they are " +
  "and what they actually do — NOT by the fact that they once appeared on the " +
  "channel (that tells you nothing about topical fit).\n\n" +
  CAVEMAN;

/**
 * Ask the model which saved guests don't fit the channel's themes. Returns the
 * indices (into `guests`) of off-topic guests with a short reason each. Never
 * throws on an empty channel context — callers guard that before calling.
 */
export async function findOffTopicGuests(
  channelContext: string,
  guests: GuestForJudge[],
): Promise<OffTopicGuest[]> {
  if (guests.length === 0) return [];

  const lines = guests
    .map((g, i) => {
      const parts = [
        g.role?.trim() ? `role: ${g.role.trim()}` : null,
        g.topics?.trim() ? `topics: ${g.topics.trim()}` : null,
        g.bio?.trim() ? `bio: ${g.bio.trim().slice(0, 300)}` : null,
      ].filter(Boolean);
      return `${i}. ${g.name}${parts.length ? ` — ${parts.join("; ")}` : ""}`;
    })
    .join("\n");

  const { offTopic } = await llmJson<{ offTopic: OffTopicGuest[] }>({
    system: SYSTEM,
    user:
      `CHANNEL CONTEXT (what the channel is about):\n${channelContext.trim().slice(0, 2000)}\n\n` +
      `Saved guests (0-based index):\n${lines}\n\n` +
      `List the indices of guests whose work does NOT connect to the channel.`,
    jsonSchema: SCHEMA,
    schemaName: "OffTopicGuests",
    maxTokens: 1500,
  });

  // Trust nothing: keep only in-range indices, dedupe, cap reason length.
  const seen = new Set<number>();
  const out: OffTopicGuest[] = [];
  for (const o of offTopic ?? []) {
    const idx = Number(o?.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= guests.length) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push({ index: idx, reason: (o.reason ?? "").trim().slice(0, 200) });
  }
  return out;
}
