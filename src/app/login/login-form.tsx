"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";

// Only honor a same-origin, path-only `next` so /login?next=//evil.example (or
// an absolute URL) can't bounce the user off-site after sign-in (open redirect).
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return "/guests";
  }
  return raw;
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const next = safeNext(searchParams.get("next"));
    const { error: signInError } = await authClient.signIn.email({
      email,
      password,
      callbackURL: next,
    });

    if (signInError) {
      setError("Invalid email or password");
      setLoading(false);
      return;
    }

    router.push(next);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-neutral-300">Email</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-base text-neutral-100 outline-none focus:border-neutral-500"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-neutral-300">Password</span>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
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
        disabled={loading}
        className="mt-2 rounded-xl bg-neutral-100 px-4 py-3 text-base font-medium text-neutral-900 transition hover:bg-white disabled:opacity-60"
      >
        {loading ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
