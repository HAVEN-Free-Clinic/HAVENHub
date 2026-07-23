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
 * Next.js `redirect()`/`notFound()` sentinels can also surface here; they are
 * intended control flow, not crashes, so they are skipped rather than reported.
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
