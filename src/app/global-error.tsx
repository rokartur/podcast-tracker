"use client";

// Top-level error boundary (wraps the root layout). Must render its own <html>.
// Generic copy only — never expose the underlying error to the client.
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          background: "#0a0a0a",
          color: "rgba(255,255,255,0.9)",
          fontFamily: "system-ui, sans-serif",
          display: "flex",
          minHeight: "100vh",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "2rem",
          textAlign: "center",
        }}
      >
        <h2 style={{ fontSize: "1.125rem", fontWeight: 500 }}>
          Something went wrong
        </h2>
        <p style={{ fontSize: "0.875rem", color: "rgba(255,255,255,0.5)" }}>
          An unexpected error occurred. Please try again.
        </p>
        <button
          onClick={reset}
          style={{
            borderRadius: "0.375rem",
            background: "rgba(255,255,255,0.1)",
            padding: "0.5rem 1rem",
            fontSize: "0.875rem",
            color: "rgba(255,255,255,0.8)",
            border: "none",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
