// Build a clean, human-readable Markdown list of guests.
// Each guest entry shows: who they are, what they do, social links and email.
import { safeWebUrl } from "@/lib/url-safety";

export type GuestForMarkdown = {
  name: string;
  role: string | null;
  bio: string | null;
  email: string | null;
  topics: string | null;
  context: string | null;
  links: string | null;
};

function splitTopics(topics: string | null): string[] {
  return (topics ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function splitLinks(links: string | null): string[] {
  return (links ?? "")
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean)
    // Keep only safe http(s) URLs, and reject any that contain characters which
    // would break out of a Markdown `[label](url)` link.
    .filter((l) => safeWebUrl(l) !== null && !/[()\s]/.test(l));
}

// Try to give a link a friendly label based on its host.
function labelForLink(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("youtube") || host.includes("youtu.be")) return "YouTube";
    if (host === "x.com" || host.includes("twitter")) return "X / Twitter";
    if (host.includes("linkedin")) return "LinkedIn";
    if (host.includes("instagram")) return "Instagram";
    if (host.includes("tiktok")) return "TikTok";
    if (host.includes("facebook")) return "Facebook";
    if (host.includes("github")) return "GitHub";
    return host;
  } catch {
    return url;
  }
}

export function guestSection(g: GuestForMarkdown): string {
  const lines: string[] = [`## ${g.name}`];

  if (g.role?.trim()) {
    lines.push(`*${g.role.trim()}*`);
  }

  const topics = splitTopics(g.topics);
  if (topics.length > 0) {
    lines.push(`**Focus areas:** ${topics.join(", ")}`);
  }

  if (g.bio?.trim()) {
    lines.push("");
    lines.push(g.bio.trim());
  }

  if (g.context?.trim()) {
    lines.push("");
    lines.push(`**Context:** ${g.context.trim()}`);
  }

  const email = g.email?.trim();
  // Only emit a mailto when the address is well-formed and free of characters
  // that would break the Markdown link.
  if (email && /^[^\s()@]+@[^\s()@]+\.[^\s()@]+$/.test(email)) {
    lines.push("");
    lines.push(`**Email:** [${email}](mailto:${email})`);
  }

  const links = splitLinks(g.links);
  if (links.length > 0) {
    lines.push("");
    lines.push("**Links:**");
    for (const l of links) {
      lines.push(`- [${labelForLink(l)}](${l})`);
    }
  }

  return lines.join("\n");
}

export function guestsToMarkdown(guests: GuestForMarkdown[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const header = [
    "# Guest list",
    "",
    `Generated: ${date} · ${guests.length} ${
      guests.length === 1 ? "guest" : "guests"
    }`,
    "",
  ].join("\n");

  if (guests.length === 0) {
    return `${header}\n_No guests._\n`;
  }

  const body = guests.map(guestSection).join("\n\n---\n\n");
  return `${header}\n${body}\n`;
}
