"use client";

// Route error boundary. Renders a generic message so raw Error details / stack
// traces never reach the client. The real error is logged to the server console
// by Next automatically.
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <h2 className="text-lg font-medium text-white/90">Something went wrong</h2>
      <p className="max-w-md text-sm text-white/50">
        An unexpected error occurred. Please try again.
      </p>
      <button
        onClick={reset}
        className="rounded-md bg-white/10 px-4 py-2 text-sm text-white/80 hover:bg-white/15"
      >
        Try again
      </button>
    </div>
  );
}
