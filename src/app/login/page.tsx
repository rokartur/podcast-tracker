import { redirect } from "next/navigation";
import { getOptionalSession } from "@/lib/session";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const sess = await getOptionalSession();
  if (sess?.user) redirect("/guests");

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-800 bg-neutral-900 p-8 shadow-xl">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-400">
          Access is invite-only. If you don&apos;t have an account, ask your
          team administrator for an invitation link.
        </p>
        <div className="mt-6">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
