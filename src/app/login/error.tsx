"use client";

import { useEffect } from "react";
import { Button } from "@/platform/ui/button";
import { Alert } from "@/platform/ui/alert";
import { CaptureException } from "@/platform/posthog/capture-exception";
import { recoverOnce } from "@/platform/posthog/client-self-heal";
import {
  STALE_DEPLOY_MESSAGE,
  STALE_SERVER_ACTION_HEAL,
  isStaleServerActionError,
} from "@/platform/posthog/stale-server-action";

/**
 * Error boundary for /login and /login/verify.
 *
 * The "Sign in with Yale" button is a plain `<form action={serverAction}>` with
 * no client catch of its own. When a tab open across a deploy posts an action id
 * the running deploy no longer has, React catches that rejection and routes it
 * to the nearest error boundary -- it never reaches a `window` error, so the
 * StaleServerActionRecovery listener cannot see it. /login had no boundary of
 * its own, so the throw fell through to the root global-error, which offers only
 * "try again"; the retry re-sends the same dead id from the same stale bundle
 * and hits the same wall, which is the recurrence we saw across members on the
 * sign-in door.
 *
 * This boundary recognises that case and reloads onto the new bundle once,
 * spending the same one-reload budget as the member form and the listener (see
 * stale-server-action.ts). Every other error keeps the branded retry.
 */
export default function LoginError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const stale = isStaleServerActionError(error);

  useEffect(() => {
    if (stale) recoverOnce(STALE_SERVER_ACTION_HEAL, error);
  }, [stale, error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-16 text-center">
      {stale ? (
        // The reload is already running; this is what the member reads during it.
        // No CaptureException here: the member is being put back on their feet, so
        // re-filing the $exception would keep the issue from ever clearing.
        <Alert tone="warning">{STALE_DEPLOY_MESSAGE}</Alert>
      ) : (
        <>
          <CaptureException error={error} />
          <h1 className="text-xl font-bold tracking-tight text-foreground">
            Something went wrong
          </h1>
          <p className="mt-2 text-muted-foreground">
            We could not load the sign-in page. Please try again. If the problem
            persists, contact the IT team.
          </p>
          <Button onClick={() => reset()} className="mt-6">
            Try again
          </Button>
        </>
      )}
    </main>
  );
}
