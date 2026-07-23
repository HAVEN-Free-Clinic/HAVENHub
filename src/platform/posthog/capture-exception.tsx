"use client";

import { useEffect } from "react";
import posthog from "posthog-js";
import { isNextControlFlowError } from "@/platform/posthog/next-control-flow";

/**
 * Reports an error-boundary error to PostHog Error Tracking. Next.js error
 * boundaries catch and swallow the thrown error, so posthog-js's global
 * exception handler never sees it; capturing here restores coverage for
 * boundary-caught errors. Renders nothing, so it can be dropped into any
 * `error.tsx` / `global-error.tsx` fallback.
 *
 * Next's `redirect()` / `notFound()` sentinels can surface here too. They are
 * intended control flow, so they are skipped rather than reported -- checked on
 * the error itself because its `digest` survives the message scrubbing Next does
 * in production, which the `before_send` filter downstream cannot see.
 */
export function CaptureException({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    if (isNextControlFlowError(error)) return;
    posthog.captureException(error);
  }, [error]);
  return null;
}
