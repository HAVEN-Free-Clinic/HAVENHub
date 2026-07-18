"use client";

import { CaptureException } from "@/platform/posthog/capture-exception";

/**
 * Root error boundary. It replaces the root layout when that layout itself
 * throws, so the app's global stylesheet is not loaded here; the fallback uses
 * inline styles and must render its own <html>/<body>. Its main job is to
 * capture the otherwise-invisible root-layout crash into PostHog Error Tracking
 * and give the user a way to retry.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          background: "#f7f8fa",
          color: "#1a1a1a",
        }}
      >
        <CaptureException error={error} />
        <main style={{ maxWidth: "28rem", padding: "2rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700, margin: 0 }}>
            Something went wrong
          </h1>
          <p style={{ marginTop: "0.5rem", color: "#555" }}>
            We hit an unexpected error. Please try again. If the problem
            persists, contact support.
          </p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: "1.5rem",
              padding: "0.5rem 1rem",
              borderRadius: "0.5rem",
              border: "none",
              background: "#1a1a1a",
              color: "#fff",
              fontSize: "0.875rem",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
