import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <h2 className="text-lg font-medium text-white/90">Page not found</h2>
      <p className="max-w-md text-sm text-white/50">
        The page you’re looking for doesn’t exist.
      </p>
      <Link
        href="/"
        className="rounded-md bg-white/10 px-4 py-2 text-sm text-white/80 hover:bg-white/15"
      >
        Go home
      </Link>
    </div>
  );
}
