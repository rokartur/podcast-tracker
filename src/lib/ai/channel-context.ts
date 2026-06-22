import "server-only";
import { llmJson } from "@/lib/ai/provider";

const SCHEMA = {
  type: "object",
  properties: {
    context: {
      type: "string",
      description:
        "A rich 6-10 sentence overview of what the channel is about overall: " +
        "its core themes and sub-themes, the type of content (tutorials, " +
        "interviews, news, builds), recurring tools/technologies, the kinds of " +
        "guests that appear, the channel's point of view/style, and who it is " +
        "for. Concrete and specific, grounded only in the videos given.",
    },
  },
  required: ["context"],
} as const;

const CAVEMAN = [
  "CAVEMAN RULES (follow exactly):",
  "- Use only the videos given. No invent.",
  "- Cover WHOLE channel, not just newest. Videos span entire catalogue.",
  "- Say main themes + sub-themes. Say content types (tutorial, interview, news, build).",
  "- Name tools/tech that repeat (Cursor, Claude, OpenAI, n8n...).",
  "- Say what kind of guests appear. Say channel point-of-view/style.",
  "- Say who channel is for.",
  "- 6 to 10 sentences. Clear. Concrete. English. No filler.",
].join("\n");

const SYSTEM =
  "You analyse a YouTube channel by reading the titles and short summaries of " +
  "its videos sampled across its whole history. Produce a clear, concrete, " +
  "comprehensive overview of what the channel is about as a whole: its main " +
  "themes and sub-themes, the type of content (tutorials, interviews, news, " +
  "builds), recurring tools or technologies, the kinds of guests featured, the " +
  "channel's style/point of view, and the target audience.\n\n" +
  CAVEMAN;

// Evenly sample up to `max` items across the full list so the summary reflects
// the ENTIRE catalogue, not only the newest videos.
function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

/**
 * Synthesise a whole-channel understanding from the titles + per-video
 * summaries we have remembered. Called after each scan so the channel context
 * keeps improving as more videos are seen. Samples across the whole catalogue
 * (newest + oldest) so the overview isn't biased toward recent uploads.
 */
export async function synthesizeChannelContext(
  videos: { title: string; summary: string | null }[],
  // Optional user instruction to steer the rewrite (tone, length, focus...).
  instruction?: string,
): Promise<string> {
  if (videos.length === 0) return "";

  const lines = sampleEvenly(videos, 160)
    .map(
      (v, i) =>
        `${i + 1}. ${v.title}${v.summary ? ` — ${v.summary}` : ""}`,
    )
    .join("\n");

  const extra = instruction?.trim()
    ? `\n\nEXTRA INSTRUCTION FROM USER (obey, but stay grounded only in the ` +
      `videos given):\n${instruction.trim()}`
    : "";

  const { context } = await llmJson<{ context: string }>({
    system: SYSTEM + extra,
    user:
      `Here are ${videos.length} videos sampled across the channel's whole ` +
      `history (title — summary):\n\n` +
      `${lines}\n\n` +
      `Describe what this channel is about overall, covering its full range.`,
    jsonSchema: SCHEMA,
    schemaName: "ChannelContext",
    maxTokens: 1200,
  });

  return (context ?? "").trim();
}
