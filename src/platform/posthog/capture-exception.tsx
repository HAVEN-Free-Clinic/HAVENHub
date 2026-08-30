"use client";

import { useEffect } from "react";
import posthog from "posthog-js";
import { isNextControlFlowError } from "@/platform/posthog/next-control-flow";
import { isServerRenderEchoError } from "@/platform/posthog/server-render-echo";
import {
  isBoundaryRecoverableError,
  recoverBoundaryError,
} from "@/platform/posthog/boundary-recovery";

/**
 * Reports an error-boundary error to PostHog Error Tracking, then gives the
 * client self-heals a chance at it. Next.js error boundaries catch and swallow
 * the thrown error, so posthog-js's global exception handler never sees it --
 * and neither do the `window` listeners the self-heals install. This restores
 * both for boundary-caught errors.
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
 *
 * Capture runs BEFORE the heal, deliberately. `recoverOnce` reloads the tab, and
 * posthog-js flushes its queue on unload -- so the `$exception` has to be queued
 * by then or the reload throws away the only record that anything went wrong.
 */
function useBoundaryCapture(error: Error & { digest?: string }): void {
  useEffect(() => {
    if (isNextControlFlowError(error) || isServerRenderEchoError(error)) return;
    posthog.captureException(error);
    recoverBoundaryError(error);
  }, [error]);
}

/**
 * Whether this boundary is reloading out of the error rather than waiting for
 * the member to act. Boundaries use it to replace a "Try again" button that
 * cannot work -- see `boundary-recovery.ts` for which errors those are.
 *
 * Decided during render from the error alone, not from state set in the effect:
 * the copy is then right on the FIRST paint, so nobody is shown "Something went
 * wrong -- try again" for a frame before it swaps. `isBoundaryRecoverableError`
 * documents the one case this over-reports (a tab that already spent its reload
 * for this crash class) and why every caller must keep an escape visible.
 */
export function useBoundaryRecovery(error: Error & { digest?: string }): boolean {
  useBoundaryCapture(error);
  return isBoundaryRecoverableError(error);
}

/**
 * Drop-in for any `error.tsx` / `global-error.tsx` fallback that does not need to
 * change its copy. Renders nothing; captures and self-heals as described above.
 */
export function CaptureException({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useBoundaryCapture(error);
  return null;
}
