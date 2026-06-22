import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { guest, teamMember } from "@/db/schema";
import { fetchAvatar, initialsSvg } from "@/lib/avatar-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Don't re-attempt a missing/failed avatar on every page load. After a failure
// we serve the initials fallback and wait this long before trying upstream again.
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

const IMAGE_CACHE = "private, max-age=86400, stale-while-revalidate=604800";

function svgResponse(name: string): Response {
  return new Response(initialsSvg(name), {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      // Short cache: a later visit may have populated the real image by then.
      "Cache-Control": "private, max-age=300",
    },
  });
}

/**
 * Serves a guest's avatar, guaranteeing an image is always returned:
 *   1. cached binary from the DB (the common, fast path), else
 *   2. fetch from upstream once, cache the bytes, serve them, else
 *   3. a deterministic initials SVG.
 * Scoped to the caller's team so avatars aren't readable across teams.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ guestId: string }> },
): Promise<Response> {
  const { guestId } = await ctx.params;

  const sess = await auth.api.getSession({ headers: await headers() });
  if (!sess?.user) return new Response("Unauthorized", { status: 401 });

  const rows = await db
    .select({
      name: guest.name,
      image: guest.image,
      links: guest.links,
      imageData: guest.imageData,
      imageType: guest.imageType,
      checkedAt: guest.imageCheckedAt,
    })
    .from(guest)
    .innerJoin(teamMember, eq(teamMember.teamId, guest.teamId))
    .where(and(eq(guest.id, guestId), eq(teamMember.userId, sess.user.id)))
    .limit(1);

  const g = rows[0];
  if (!g) return new Response("Not found", { status: 404 });

  // 1. Cached bytes.
  if (g.imageData && g.imageData.byteLength > 0) {
    return new Response(new Uint8Array(g.imageData), {
      headers: {
        "Content-Type": g.imageType ?? "image/jpeg",
        "Cache-Control": IMAGE_CACHE,
      },
    });
  }

  // Recently attempted and still empty — serve the fallback without re-fetching.
  if (g.checkedAt && Date.now() - g.checkedAt.getTime() < RETRY_AFTER_MS) {
    return svgResponse(g.name);
  }

  // 2. Fetch once and cache.
  const fetched = await fetchAvatar(g.image, g.links);
  if (fetched) {
    await db
      .update(guest)
      .set({
        imageData: fetched.data,
        imageType: fetched.type,
        imageCheckedAt: new Date(),
      })
      .where(eq(guest.id, guestId));
    return new Response(new Uint8Array(fetched.data), {
      headers: { "Content-Type": fetched.type, "Cache-Control": IMAGE_CACHE },
    });
  }

  // 3. Nothing resolved — record the attempt, serve initials.
  await db
    .update(guest)
    .set({ imageCheckedAt: new Date() })
    .where(eq(guest.id, guestId));
  return svgResponse(g.name);
}
