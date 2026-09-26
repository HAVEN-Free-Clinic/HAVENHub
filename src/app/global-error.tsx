"use client";

import {
  BOUNDARY_RECOVERING_MESSAGE,
  BOUNDARY_RECOVERING_TITLE,
} from "@/platform/posthog/boundary-recovery";
import { useBoundaryRecovery } from "@/platform/posthog/capture-exception";

/**
 * Root error boundary. It replaces the root layout when that layout itself
 * throws, so the app's global stylesheet is not loaded here; the fallback uses
 * inline styles and must render its own <html>/<body>. Its main job is to
 * capture the otherwise-invisible root-layout crash into PostHog Error Tracking
 * and give the user a way to retry.
 *
 * It is also the boundary `/login` falls through to, because `/login` has none
 * of its own -- which is how the stale Server Action id from the "Sign in with
 * Yale" button ended up here, offering a "Try again" that re-sent the same dead
 * id. `useBoundaryRecovery` reloads out of that class of error and tells us so,
 * which is what the branch below is for. See `boundary-recovery.ts`.
 *
 * "Try again" calls `retry()`, which re-fetches before re-rendering, not
 * `reset()`, which re-renders the same failed result without a request. The
 * root boundary gets the same `retry` as every segment boundary (Next wraps
 * both in one ErrorBoundaryHandler, inside the router context it refreshes). A
 * network drop on `/login` ("TypeError: Load failed", 2026-09-23) lands here.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const recovering = useBoundaryRecovery(error);

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
        <main style={{ maxWidth: "28rem", padding: "2rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700, margin: 0 }}>
            {recovering ? BOUNDARY_RECOVERING_TITLE : "Something went wrong"}
          </h1>
          <p style={{ marginTop: "0.5rem", color: "#555" }}>
            {recovering
              ? BOUNDARY_RECOVERING_MESSAGE
              : "We hit an unexpected error. Please try again. If the problem persists, contact support."}
          </p>
          {/* While recovering the retry is withheld -- it is the one action that
              cannot work, because it re-sends the same dead action id from the
              same stale bundle. A manual reload takes its place rather than
              leaving no button at all: `isBoundaryRecoverableError` is a class
              check, so a tab that already spent its automatic reload lands here
              too, and it must not be a dead end. */}
          <button
            onClick={() => (recovering ? window.location.reload() : retry())}
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
            {recovering ? "Reload now" : "Try again"}
          </button>
        </main>
      </body>
    </html>
  );
}
