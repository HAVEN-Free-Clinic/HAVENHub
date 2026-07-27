"use client";

import { useEffect } from "react";
import posthog from "posthog-js";
import { isNextControlFlowError } from "@/platform/posthog/next-control-flow";
import { isServerRenderEchoError } from "@/platform/posthog/server-render-echo";

/**
 * Reports an error-boundary error to PostHog Error Tracking. Next.js error
 * boundaries catch and swallow the thrown error, so posthog-js's global
 * exception handler never sees it; capturing here restores coverage for
 * boundary-caught errors. Renders nothing, so it can be dropped into any
 * `error.tsx` / `global-error.tsx` fallback.
 *
 * Two things that are not client bugs also land here, and are skipped:
 *
 *   - Next's `redirect()` / `notFound()` sentinels, which are intended control
 *     flow -- checked on the error itself because its `digest` survives the
 *     message scrubbing Next does in production, which the `before_send` filter
 *     downstream cannot see.
 *   - React's redacted stand-in for a server-side render failure, which carries
 *     no message or stack of its own and duplicates an error the server already
 *     reported in full (see `server-render-echo.ts`).
 */
export function CaptureException({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    if (isNextControlFlowError(error) || isServerRenderEchoError(error)) return;
    posthog.captureException(error);
  }, [error]);
  return null;
}
