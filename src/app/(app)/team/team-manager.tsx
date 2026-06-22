"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createInvite, revokeInvite } from "@/lib/actions/invite";

type Member = {
  id: string;
  role: "owner" | "admin" | "member";
  name: string;
  email: string;
};

type Pending = {
  id: string;
  email: string;
  role: "owner" | "admin" | "member";
  token: string;
  expiresAt: string;
};

const roleBadge: Record<Member["role"], string> = {
  owner: "bg-amber-500/15 text-amber-300",
  admin: "bg-sky-500/15 text-sky-300",
  member: "bg-white/10 text-white/60",
};

function inviteLink(token: string) {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/invite/${token}`;
}

export function TeamManager({
  canInviteAdmins,
  members,
  pending,
}: {
  canInviteAdmins: boolean;
  members: Member[];
  pending: Pending[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLink(null);

    startTransition(async () => {
      try {
        const { token } = await createInvite({ email, role });
        setLink(inviteLink(token));
        setEmail("");
        setRole("member");
        toast.success("Invite link created.");
        router.refresh();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Could not create the invite. Please try again.",
        );
      }
    });
  }

  function handleRevoke(id: string) {
    startTransition(async () => {
      try {
        await revokeInvite({ id });
        toast.success("Invite revoked.");
        router.refresh();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not revoke the invite.",
        );
      }
    });
  }

  async function copyLink(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Invite link copied.");
    } catch {
      // Clipboard blocked — the link stays selectable in the input.
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h2 className="mb-4 text-lg font-semibold text-white">Invite a user</h2>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <label className="flex flex-1 flex-col gap-1.5 text-sm">
            <span className="text-white/60">Email</span>
            <input
              type="email"
              required
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@example.com"
              className="rounded-xl border border-white/15 bg-neutral-950 px-4 py-2.5 text-base text-white outline-none focus:border-white/40"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-white/60">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "member" | "admin")}
              className="rounded-xl border border-white/15 bg-neutral-950 px-4 py-2.5 text-base text-white outline-none focus:border-white/40"
            >
              <option value="member">Member</option>
              {canInviteAdmins && <option value="admin">Admin</option>}
            </select>
          </label>

          <button
            type="submit"
            disabled={isPending}
            className="rounded-xl bg-white px-4 py-2.5 text-base font-medium text-neutral-900 transition hover:bg-white/90 disabled:opacity-60"
          >
            {isPending ? "Creating…" : "Create invite"}
          </button>
        </form>

        {error && (
          <p className="mt-3 rounded-lg bg-red-950 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}

        {link && (
          <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-3">
            <p className="mb-2 text-sm text-emerald-300">
              Invite link created. Share it with the new user — they set their
              own name and password.
            </p>
            <div className="flex gap-2">
              <input
                readOnly
                value={link}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 rounded-lg border border-white/15 bg-neutral-950 px-3 py-2 text-sm text-white/80"
              />
              <button
                type="button"
                onClick={() => copyLink(link)}
                className="rounded-lg border border-white/15 px-3 py-2 text-sm text-white/80 transition hover:bg-white/10"
              >
                Copy
              </button>
            </div>
          </div>
        )}
      </section>

      {pending.length > 0 && (
        <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <h2 className="mb-4 text-lg font-semibold text-white">
            Pending invites
          </h2>
          <ul className="divide-y divide-white/5">
            {pending.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-3 py-3"
              >
                <span className="text-sm text-white">{p.email}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${roleBadge[p.role]}`}
                >
                  {p.role}
                </span>
                <span className="text-xs text-white/40">
                  expires {new Date(p.expiresAt).toLocaleDateString()}
                </span>
                <div className="ml-auto flex gap-2">
                  <button
                    type="button"
                    onClick={() => copyLink(inviteLink(p.token))}
                    className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 transition hover:bg-white/10"
                  >
                    Copy link
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRevoke(p.id)}
                    disabled={isPending}
                    className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs text-red-400 transition hover:bg-red-500/10 disabled:opacity-60"
                  >
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h2 className="mb-4 text-lg font-semibold text-white">Members</h2>
        <ul className="divide-y divide-white/5">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-white">{m.name}</p>
                <p className="truncate text-xs text-white/40">{m.email}</p>
              </div>
              <span
                className={`ml-auto rounded-full px-2 py-0.5 text-xs ${roleBadge[m.role]}`}
              >
                {m.role}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
