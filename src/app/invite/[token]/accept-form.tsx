"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptInvite } from "@/lib/actions/invite";

export function AcceptForm({
  token,
  email,
  teamName,
}: {
  token: string;
  email: string;
  teamName: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 10) {
      setError("Password must be at least 10 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }

    startTransition(async () => {
      try {
        await acceptInvite({ token, name, password });
        router.push("/login?invited=1");
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Something went wrong. Please try again.",
        );
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-neutral-300">Team</span>
        <input
          type="text"
          readOnly
          value={teamName}
          className="rounded-xl border border-neutral-800 bg-neutral-950 px-4 py-3 text-base text-neutral-400"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-neutral-300">Email</span>
        <input
          type="email"
          readOnly
          value={email}
          className="rounded-xl border border-neutral-800 bg-neutral-950 px-4 py-3 text-base text-neutral-400"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-neutral-300">Full name</span>
        <input
          type="text"
          required
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-base text-neutral-100 outline-none focus:border-neutral-500"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-neutral-300">Password (min. 10 characters)</span>
        <input
          type="password"
          required
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-base text-neutral-100 outline-none focus:border-neutral-500"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-neutral-300">Confirm password</span>
        <input
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-base text-neutral-100 outline-none focus:border-neutral-500"
        />
      </label>

      {error && (
        <p className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="mt-2 rounded-xl bg-neutral-100 px-4 py-3 text-base font-medium text-neutral-900 transition hover:bg-white disabled:opacity-60"
      >
        {isPending ? "Creating account…" : "Join team"}
      </button>
    </form>
  );
}
