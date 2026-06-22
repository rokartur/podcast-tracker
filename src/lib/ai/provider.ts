import "server-only";
import Anthropic from "@anthropic-ai/sdk";

type Provider = "anthropic" | "openrouter";

// Hard ceiling on any single model call so a hung upstream can't stall a scan
// (which processes videos sequentially) indefinitely.
const LLM_TIMEOUT_MS = 60_000;

function resolveProvider(): Provider {
  const explicit = process.env.AI_PROVIDER;
  if (explicit === "anthropic" || explicit === "openrouter") return explicit;
  return process.env.OPENROUTER_API_KEY ? "openrouter" : "anthropic";
}

// Reuse one Anthropic client across calls instead of constructing one per
// request (each constructor allocates a keep-alive agent etc.).
let anthropicClient: Anthropic | null = null;
function getAnthropic(apiKey: string): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey,
      timeout: LLM_TIMEOUT_MS,
      maxRetries: 2,
    });
  }
  return anthropicClient;
}

function stripFences(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    // remove opening fence (```json or ```), and trailing fence
    s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  }
  return s.trim();
}

export interface LlmJsonOpts {
  system: string;
  user: string;
  jsonSchema: object;
  schemaName: string;
  maxTokens?: number;
}

/**
 * Provider-agnostic structured-JSON completion. Returns parsed T.
 * Provider chosen via AI_PROVIDER env (or inferred from available API key).
 *
 * NOTE: the returned object is NOT trusted — callers must validate/sanitize the
 * shape and any URL/email fields before persisting or rendering it (the model
 * can be steered by injected content in scraped pages or user topics).
 */
export async function llmJson<T>(opts: LlmJsonOpts): Promise<T> {
  const provider = resolveProvider();
  const maxTokens = opts.maxTokens ?? 2000;

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
    const client = getAnthropic(apiKey);
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system:
        opts.system +
        "\nReply with ONLY valid minified JSON matching this JSON Schema, no prose, no code fences:\n" +
        JSON.stringify(opts.jsonSchema),
      messages: [{ role: "user", content: opts.user }],
    });
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      throw new Error("AI provider returned no text content");
    }
    return JSON.parse(stripFences(block.text)) as T;
  }

  // openrouter
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  // Default to a fast non-reasoning model. Reasoning models (e.g. gpt-5-mini,
  // o*) spend most of the token budget on hidden reasoning and return
  // truncated or empty JSON for this task. Override with OPENROUTER_MODEL.
  const model = process.env.OPENROUTER_MODEL ?? "anthropic/claude-haiku-4.5";
  const base = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Podcast Tracker",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          {
            role: "system",
            content:
              opts.system + " Respond with ONLY valid JSON matching the schema.",
          },
          {
            role: "user",
            content:
              opts.user + "\nJSON Schema: " + JSON.stringify(opts.jsonSchema),
          },
        ],
        response_format: { type: "json_object" },
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Log the upstream body server-side for diagnostics, but never echo it to
    // the caller (it can surface in client-facing error messages).
    const body = await res.text().catch(() => "");
    console.error(`openrouter error ${res.status} ${res.statusText}: ${body}`);
    throw new Error("AI provider request failed");
  }

  const data = (await res.json()) as {
    choices?: {
      finish_reason?: string;
      message?: { content?: string };
    }[];
  };
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    if (choice?.finish_reason === "length") {
      throw new Error(
        `The AI model ran out of tokens before answering (likely a reasoning ` +
          `model). Set OPENROUTER_MODEL to a non-reasoning model.`,
      );
    }
    throw new Error("AI provider returned an empty response");
  }
  try {
    return JSON.parse(stripFences(content)) as T;
  } catch {
    throw new Error("AI provider returned invalid JSON");
  }
}
