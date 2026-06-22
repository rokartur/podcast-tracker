import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  uniqueIndex,
  index,
  pgEnum,
  customType,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Raw binary column (Postgres `bytea`). Used to cache avatar images directly in
// the DB so they render even when the upstream avatar host is down/rate-limited.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// ---------------------------------------------------------------------------
// better-auth core tables (user / session / account / verification)
// Column property names are camelCase to match better-auth field names.
// drizzle.config `casing: "snake_case"` maps them to snake_case SQL columns.
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // admin plugin fields
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonated_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Application tables. Every row is scoped to a team for data isolation.
// ---------------------------------------------------------------------------

export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);
export const episodeStatus = pgEnum("episode_status", [
  "idea",
  "scheduled",
  "recorded",
  "editing",
  "published",
]);
export const taskStatus = pgEnum("task_status", ["todo", "doing", "done"]);

export const team = pgTable("team", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const teamMember = pgTable(
  "team_member",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull().default("member"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("team_member_team_user_uq").on(t.teamId, t.userId)],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: memberRole("role").notNull().default("member"),
    token: text("token").notNull().unique(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("invitation_email_idx").on(t.email)],
);

export const podcast = pgTable(
  "podcast",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("podcast_team_idx").on(t.teamId)],
);

export const episode = pgTable(
  "episode",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    podcastId: text("podcast_id")
      .notNull()
      .references(() => podcast.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: episodeStatus("status").notNull().default("idea"),
    notes: text("notes"),
    recordedAt: timestamp("recorded_at"),
    publishedAt: timestamp("published_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("episode_team_idx").on(t.teamId)],
);

export const guest = pgTable(
  "guest",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Short "what they do" label, e.g. "Founder of Cursor". Shown in the table.
    role: text("role"),
    // Avatar URL derived from a social profile (via unavatar.io) if available.
    image: text("image"),
    // Avatar image cached as binary in the DB so it always renders, even when
    // the upstream host (unavatar.io) is down or rate-limiting. Populated lazily
    // by the /api/avatar/[guestId] route on first request. `imageCheckedAt` is
    // the last fetch attempt (success or failure) so we don't hammer a missing
    // source on every page load.
    imageData: bytea("image_data"),
    imageType: text("image_type"),
    imageCheckedAt: timestamp("image_checked_at"),
    bio: text("bio"),
    email: text("email"),
    topics: text("topics"), // comma-separated areas of expertise
    // Context captured from David Ondrej's channel: how/why this person showed
    // up (which video, what was discussed). Used instead of topics for the
    // channel scraper.
    context: text("context"),
    links: text("links"), // newline-separated URLs (site, social)
    // Audience reach, best-effort scraped from the guest's profiles. Used for
    // sorting by influence. Null = unknown (not yet fetched / not found).
    youtubeSubscribers: integer("youtube_subscribers"),
    xFollowers: integer("x_followers"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("guest_team_idx").on(t.teamId)],
);

export const episodeGuest = pgTable(
  "episode_guest",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id")
      .notNull()
      .references(() => episode.id, { onDelete: "cascade" }),
    guestId: text("guest_id")
      .notNull()
      .references(() => guest.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("episode_guest_uq").on(t.episodeId, t.guestId),
  ],
);

// ---------------------------------------------------------------------------
// Channel "memory" for the YouTube channel scraper.
//
// `channel` is one row per tracked YouTube channel (per team). It remembers the
// resolved YouTube channel id, last scrape time and running counters.
//
// `channelVideo` is the actual memory: one row per video we have already seen
// and processed. A unique index on (channelId, videoId) makes re-scraping
// idempotent — only videos NOT yet in this table are treated as "new", so the
// memory naturally grows as fresh videos are published. We store the people we
// detected per video so we can show who showed up where.
// ---------------------------------------------------------------------------

export const channel = pgTable(
  "channel",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    // YouTube handle, e.g. "@DavidOndrej".
    handle: text("handle").notNull(),
    // Resolved canonical channel id, e.g. "UCxxxx" (filled in on first scrape).
    youtubeChannelId: text("youtube_channel_id"),
    title: text("title"),
    url: text("url").notNull(),
    description: text("description"),
    // AI-synthesised understanding of what the whole channel is about, rebuilt
    // from every remembered video on each scan.
    context: text("context"),
    // Running totals so the UI can show memory state at a glance.
    videosSeen: integer("videos_seen").notNull().default(0),
    guestsFound: integer("guests_found").notNull().default(0),
    lastScrapedAt: timestamp("last_scraped_at"),
    // Set once the expensive full back-catalogue enumeration has finished (no
    // more new/stale videos left). After this, scans only check the newest
    // uploads via RSS instead of paging the whole channel each time.
    fullScanCompletedAt: timestamp("full_scan_completed_at"),
    // Daily auto-scan schedule. When enabled, a cron job scans this channel
    // once a day at `scheduleHour` (0-23, server local time), simply picking up
    // the newest videos it hasn't seen yet. `lastAutoRunDate` holds the
    // YYYY-MM-DD of the last automatic run so we never run twice in a day.
    scheduleEnabled: boolean("schedule_enabled").notNull().default(false),
    scheduleHour: integer("schedule_hour").notNull().default(8),
    lastAutoRunDate: text("last_auto_run_date"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("channel_team_handle_uq").on(t.teamId, t.handle)],
);

export const channelVideo = pgTable(
  "channel_video",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    // YouTube video id (the part after watch?v=).
    videoId: text("video_id").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    publishedAt: timestamp("published_at"),
    // Short AI summary of what this specific video is about.
    summary: text("summary"),
    // Comma-separated names of people detected in this video (empty if none).
    peopleFound: text("people_found"),
    processedAt: timestamp("processed_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("channel_video_uq").on(t.channelId, t.videoId),
    index("channel_video_team_idx").on(t.teamId),
  ],
);

export const task = pgTable(
  "task",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    episodeId: text("episode_id").references(() => episode.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    status: taskStatus("status").notNull().default("todo"),
    dueAt: timestamp("due_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("task_team_idx").on(t.teamId)],
);

// --- relations (for typed `db.query` joins) ---

export const teamRelations = relations(team, ({ many }) => ({
  members: many(teamMember),
  podcasts: many(podcast),
  guests: many(guest),
}));

export const podcastRelations = relations(podcast, ({ one, many }) => ({
  team: one(team, { fields: [podcast.teamId], references: [team.id] }),
  episodes: many(episode),
}));

export const episodeRelations = relations(episode, ({ one, many }) => ({
  podcast: one(podcast, {
    fields: [episode.podcastId],
    references: [podcast.id],
  }),
  guests: many(episodeGuest),
  tasks: many(task),
}));

export const guestRelations = relations(guest, ({ many }) => ({
  episodes: many(episodeGuest),
}));

export const channelRelations = relations(channel, ({ one, many }) => ({
  team: one(team, { fields: [channel.teamId], references: [team.id] }),
  videos: many(channelVideo),
}));

export const channelVideoRelations = relations(channelVideo, ({ one }) => ({
  channel: one(channel, {
    fields: [channelVideo.channelId],
    references: [channel.id],
  }),
}));

export const episodeGuestRelations = relations(episodeGuest, ({ one }) => ({
  episode: one(episode, {
    fields: [episodeGuest.episodeId],
    references: [episode.id],
  }),
  guest: one(guest, {
    fields: [episodeGuest.guestId],
    references: [guest.id],
  }),
}));
