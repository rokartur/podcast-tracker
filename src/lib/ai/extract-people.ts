import "server-only";
import { llmJson } from "@/lib/ai/provider";

// A person detected in one of David Ondrej's videos.
export type DetectedPerson = {
  name: string;
  relevant: boolean; // true only if linked to the channel's themes
  role: string; // what they do, e.g. "Founder of Cursor", "AI researcher"
  topics: string[]; // 2–5 areas of expertise / themes they're known for
  bio: string; // 2–3 sentence summary of who they are / why notable
  context: string; // why/how they showed up & why they'd make a good guest
  email: string; // public contact email if confidently known, else ""
  x: string; // X/Twitter URL if confidently known, else ""
  youtube: string; // YouTube channel URL if confidently known, else ""
  linkedin: string; // LinkedIn profile URL if confidently known, else ""
  github: string; // GitHub profile URL if confidently known, else ""
  instagram: string; // Instagram profile URL if confidently known, else ""
  website: string; // Personal/company website URL if confidently known, else ""
};

const SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "A rich 2-3 sentence summary of the video: what it covers, which tools/techniques are shown, who appears, and the key takeaway. Concrete, not generic.",
    },
    people: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          relevant: {
            type: "boolean",
            description:
              "TRUE only if this person's work/expertise clearly connects to " +
              "the channel's themes described in CHANNEL CONTEXT (AI agents, " +
              "autonomous coding, AI dev tools, prompt engineering, AI " +
              "startups, etc). A person who merely appears but has no link to " +
              "what the channel is about is FALSE. If no CHANNEL CONTEXT is " +
              "given, default to TRUE.",
          },
          role: {
            type: "string",
            description:
              "What this person does in one short phrase, e.g. 'Founder of Cursor' or 'AI researcher at OpenAI'. Always provide your best-guess role; never leave it empty.",
          },
          topics: {
            type: "array",
            items: { type: "string" },
            description:
              "2-5 short areas of expertise or themes this person is known for, e.g. ['AI agents','autonomous coding','startups']. Always provide at least 2.",
          },
          bio: {
            type: "string",
            description:
              "2-3 sentence bio: who they are, what they've built or are known for, and why they matter in the AI space.",
          },
          context: {
            type: "string",
            description:
              "How/why this person appears in this video and why they'd make a strong podcast guest. One or two sentences.",
          },
          email: {
            type: "string",
            description:
              "Public contact email if confidently known, otherwise an empty string. Never invent one.",
          },
          x: {
            type: "string",
            description:
              "Full X/Twitter profile URL if confidently known, otherwise an empty string. Never invent one.",
          },
          youtube: {
            type: "string",
            description:
              "Full YouTube channel URL if confidently known, otherwise an empty string. Never invent one.",
          },
          linkedin: {
            type: "string",
            description:
              "Full LinkedIn profile URL if confidently known, otherwise an empty string. Never invent one.",
          },
          github: {
            type: "string",
            description:
              "Full GitHub profile URL if confidently known, otherwise an empty string. Never invent one.",
          },
          instagram: {
            type: "string",
            description:
              "Full Instagram profile URL if confidently known, otherwise an empty string. Never invent one.",
          },
          website: {
            type: "string",
            description:
              "Personal or company website URL if confidently known, otherwise an empty string. Never invent one.",
          },
        },
        required: [
          "name",
          "relevant",
          "role",
          "topics",
          "bio",
          "context",
          "email",
          "x",
          "youtube",
          "linkedin",
          "github",
          "instagram",
          "website",
        ],
      },
    },
  },
  required: ["summary", "people"],
} as const;

// "Caveman full" guidance — short, blunt, high-signal rules the model can't
// gloss over. Keeps output concrete and honest.
const CAVEMAN = [
  "CAVEMAN RULES (follow exactly):",
  "- REAL people only. No name in video, no person. No guess-people.",
  "- David Ondrej NOT a guest. Never list him.",
  "- relevant=true ONLY if person work/expertise connect to CHANNEL CONTEXT themes. No link to channel topic -> relevant=false.",
  "- No CHANNEL CONTEXT given -> relevant=true for all real people.",
  "- Solo tutorial, nobody named -> people list EMPTY. That is fine.",
  "- Every person: fill name, role, topics, bio, context. No empty role. No empty topics.",
  "- bio = who they are + what they built. Real facts. No fluff.",
  "- context = why they in THIS video + why good podcast guest.",
  "- email, x, youtube, linkedin, github, instagram, website: only if you SURE real. Not sure -> empty string. Never make up.",
  "- Give ALL social links you are sure about, not just one.",
  "- Look hard in the description for a business/contact email; if present, use it.",
  "- summary = what video really about + tools shown + takeaway. Be specific.",
  "- All text English. Short. Strong. True.",
].join("\n");

const SYSTEM =
  "You analyse YouTube videos from David Ondrej's channel. The channel is about " +
  "building with AI: AI agents, autonomous coding, AI developer tools (such as " +
  "Cursor, Claude, OpenAI, n8n), prompt engineering and AI startups. " +
  "You are given a video's title, description and (when available) its caption " +
  "transcript. Use ALL of them — especially the transcript — to understand what " +
  "the video is really about. Write a rich summary of the video and " +
  "identify the specific REAL people who appear in or are the clear subject of " +
  "the video besides David Ondrej himself (interview guests, founders, " +
  "researchers, builders who are named). For each person produce the best, most " +
  "useful profile you can so a podcast booker can act on it.\n\n" +
  CAVEMAN;

export type VideoAnalysis = {
  summary: string;
  people: DetectedPerson[];
};

export async function extractPeopleFromVideo(input: {
  title: string;
  description: string;
  transcript?: string;
  // Whole-channel overview. When present, only people whose work connects to
  // these themes are kept; when empty, every named real person is kept.
  channelContext?: string;
}): Promise<VideoAnalysis> {
  const desc = input.description.slice(0, 4000);
  const transcript = (input.transcript ?? "").slice(0, 6000);
  const channelContext = (input.channelContext ?? "").trim().slice(0, 2000);
  const { summary, people } = await llmJson<VideoAnalysis>({
    system: SYSTEM,
    user:
      (channelContext
        ? `CHANNEL CONTEXT (what David's channel is about):\n${channelContext}\n\n`
        : "") +
      `Video title: ${input.title}\n\n` +
      `Video description:\n${desc || "(no description)"}\n\n` +
      `Caption transcript:\n${transcript || "(no transcript available)"}\n\n` +
      `Using the title, description and transcript, write the rich video ` +
      `summary, then list the named real people (excluding David Ondrej) who ` +
      `appear in or are the subject of this video, each with a strong, ` +
      `concrete profile. Set relevant=true only for people whose work ` +
      `connects to the CHANNEL CONTEXT themes` +
      (channelContext ? `.` : ` (no context given, so relevant=true for all).`),
    jsonSchema: SCHEMA,
    schemaName: "VideoAnalysis",
    maxTokens: 2200,
  });

  return {
    summary: (summary ?? "").trim(),
    people: (people ?? [])
      .filter((p) => p.name?.trim())
      .filter((p) => !/david\s+ondrej/i.test(p.name))
      // Only keep people the model judged connected to the channel's themes.
      // When no channel context was supplied the model defaults relevant=true.
      .filter((p) => p.relevant !== false),
  };
}
