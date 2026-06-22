import "server-only";
import { llmJson } from "@/lib/ai/provider";

export type GuestSuggestion = {
  name: string;
  expertise: string;
  topics: string[];
  bio: string;
  context: string;
  whereToFind: string;
  email: string;
  youtube: string;
  x: string;
  linkedin: string;
  github: string;
  instagram: string;
  website: string;
};

const SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          expertise: {
            type: "string",
            description:
              "Short 'what they do' phrase, e.g. 'Founder of Cursor' or 'AI researcher at OpenAI'. Never empty.",
          },
          topics: {
            type: "array",
            items: { type: "string" },
            description:
              "2-5 short areas of expertise / talking points for this guest. Always at least 2.",
          },
          bio: {
            type: "string",
            description:
              "2-3 sentence bio: who they are, what they've built or are known for, why they matter.",
          },
          context: {
            type: "string",
            description:
              "Why this person fits the topic and would make a strong podcast guest. One or two sentences.",
          },
          whereToFind: {
            type: "string",
            description:
              "Where to find or contact them (platform, site, or channel).",
          },
          email: {
            type: "string",
            description:
              "Public contact email if known, otherwise an empty string. Never invent one.",
          },
          youtube: {
            type: "string",
            description:
              "Full YouTube channel URL if known, otherwise an empty string. Never invent one.",
          },
          x: {
            type: "string",
            description:
              "Full X/Twitter profile URL if known, otherwise an empty string. Never invent one.",
          },
          linkedin: {
            type: "string",
            description:
              "Full LinkedIn profile URL if known, otherwise an empty string. Never invent one.",
          },
          github: {
            type: "string",
            description:
              "Full GitHub profile URL if known, otherwise an empty string. Never invent one.",
          },
          instagram: {
            type: "string",
            description:
              "Full Instagram profile URL if known, otherwise an empty string. Never invent one.",
          },
          website: {
            type: "string",
            description:
              "Personal or company website URL if known, otherwise an empty string. Never invent one.",
          },
        },
        required: [
          "name",
          "expertise",
          "topics",
          "bio",
          "context",
          "whereToFind",
          "email",
          "youtube",
          "x",
          "linkedin",
          "github",
          "instagram",
          "website",
        ],
      },
    },
  },
  required: ["suggestions"],
} as const;

// "Caveman full" guidance — short, blunt, high-signal rules.
const CAVEMAN = [
  "CAVEMAN RULES (follow exactly):",
  "- Real expert humans only. Strong fit for topic.",
  "- Every guest: fill name, expertise, topics, bio, context, whereToFind. Nothing empty.",
  "- bio = real facts. Who they are. What they built. No fluff.",
  "- context = why they fit THIS topic + why good podcast guest.",
  "- topics = 2 to 5 short talking points.",
  "- email, youtube, x, linkedin, github, instagram, website: only if you SURE real. Not sure -> empty string. Never make up.",
  "- Give ALL social links you are sure about, not just one.",
  "- All text English. Short. Strong. True.",
].join("\n");

const SYSTEM =
  "You are an expert podcast booking producer. Given a topic, propose strong " +
  "guest candidates. Use a real person's name when you are confident, otherwise " +
  "a representative example or role-based archetype. For each guest produce the " +
  "best, most useful profile a booker can act on: their expertise, talking " +
  "topics, a concrete bio, why they fit, where to find them, and verified " +
  "public contact details (email, YouTube, X).\n\n" +
  CAVEMAN;

export async function suggestGuests(
  topic: string,
  count = 5,
): Promise<GuestSuggestion[]> {
  const { suggestions } = await llmJson<{ suggestions: GuestSuggestion[] }>({
    system: SYSTEM,
    user: `Topic: ${topic}\nPropose ${count} guests, each with a strong, concrete profile.`,
    jsonSchema: SCHEMA,
    schemaName: "GuestSuggestions",
    maxTokens: 3000,
  });
  return (suggestions ?? []).slice(0, count);
}
