import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { guest } from "@/db/schema";
import { requireMember } from "@/lib/session";
import { GuestFinder } from "./guest-finder";
import { GuestList } from "./guest-list";

export default async function GuestsPage() {
  const { teamId } = await requireMember();

  const guests = await db
    .select({
      id: guest.id,
      name: guest.name,
      role: guest.role,
      image: guest.image,
      bio: guest.bio,
      email: guest.email,
      topics: guest.topics,
      context: guest.context,
      links: guest.links,
      youtubeSubscribers: guest.youtubeSubscribers,
      xFollowers: guest.xFollowers,
    })
    .from(guest)
    .where(eq(guest.teamId, teamId))
    .orderBy(desc(guest.createdAt));

  return (
    <div className="w-full space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-white">Guests</h1>
        <p className="text-sm text-white/40">
          Find guests by category or topic, then export the list to Markdown.
        </p>
      </header>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h2 className="mb-4 text-lg font-semibold text-white">Find guests</h2>
        <GuestFinder />
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h2 className="mb-4 text-lg font-semibold text-white">Saved guests</h2>
        <GuestList guests={guests} />
      </section>
    </div>
  );
}
