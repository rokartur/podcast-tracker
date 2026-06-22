"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";

const links = [
  { href: "/guests", label: "Guests" },
  { href: "/channel", label: "Channel" },
];

export function Nav({
  teamName,
  user,
  role,
}: {
  teamName: string;
  user: { name: string };
  role: "owner" | "admin" | "member";
}) {
  const pathname = usePathname();
  const router = useRouter();

  // Team management is owner/admin only — hide the link for plain members.
  const navLinks =
    role === "owner" || role === "admin"
      ? [...links, { href: "/team", label: "Team" }]
      : links;

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  return (
    <header className="border-b border-neutral-800 bg-neutral-950">
      <div className="flex w-full flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
        <span className="text-base font-semibold tracking-tight">
          {teamName}
        </span>

        <nav className="flex flex-wrap items-center gap-1">
          {navLinks.map((link) => {
            const active =
              pathname === link.href || pathname.startsWith(link.href + "/");
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded-lg px-3 py-1.5 text-sm transition ${
                  active
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:text-neutral-100"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-neutral-400">{user.name}</span>
          <button
            onClick={handleSignOut}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition hover:bg-neutral-800"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
