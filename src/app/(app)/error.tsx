"use client";
import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import {
  BOUNDARY_RECOVERING_MESSAGE,
  BOUNDARY_RECOVERING_TITLE,
} from "@/platform/posthog/boundary-recovery";
import { useBoundaryRecovery } from "@/platform/posthog/capture-exception";

/**
 * Single error boundary for the whole authenticated (app) tree. It renders in
 * place of the failed page body but stays inside AppShell, so the toolbar and
 * navigation survive a thrown server component (a transient DB/Graph error, an
 * unexpected null) instead of falling through to Next's bare error screen.
 * `retry()` re-fetches the segment from the server and re-renders it; the link
 * is a guaranteed way back.
 *
 * `retry`, not `reset`. In this Next version `reset()` only clears the error
 * state and re-renders what the client already holds, so an error that came
 * from a failed fetch is thrown again from the same failed result without a new
 * request. Error Tracking caught exactly that on 2026-09-17: a network drop
 * ("TypeError: Load failed", Mobile Safari) on the applicants roster, then two
 * "Try again" presses, each re-logging the identical error ~45ms later with no
 * request in between. `retry()` refreshes the route before clearing the error,
 * so a transient network failure is the one case it reliably fixes. See
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md.
 *
 * Some errors arrive here that no amount of retrying clears -- a Server Action
 * whose response came back unreadable (issue 01a017d1, seen on `/my-info`), a
 * stale action id after a deploy, a dropped chunk. `useBoundaryRecovery` reloads
 * once out of those and reports it, and the retry is withheld while it does, so
 * the member is not handed the one instruction that cannot work. See
 * `boundary-recovery.ts`.
 */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const recovering = useBoundaryRecovery(error);

  return (
    <div className="mx-auto max-w-lg py-12">
      <Card className="text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-[13px] bg-critical-faint text-critical">
          {recovering ? (
            <RefreshCw aria-hidden className="h-6 w-6 animate-spin" />
          ) : (
            <AlertTriangle aria-hidden className="h-6 w-6" />
          )}
        </span>
        <h1 className="mt-4 text-lg font-bold tracking-tight text-foreground">
          {recovering ? BOUNDARY_RECOVERING_TITLE : "Something went wrong"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {recovering
            ? BOUNDARY_RECOVERING_MESSAGE
            : "We hit an unexpected error loading this page. Please try again. If the problem persists, contact support."}
        </p>
        {/* The retry is withheld while recovering -- it cannot clear any of the
            three errors we reload out of. "Back to Hub" stays either way, so a
            tab that has already spent its automatic reload (see
            isBoundaryRecoverableError) is never left without a way out. */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
          {!recovering && <Button onClick={() => retry()}>Try again</Button>}
          {/* "Back to Hub" names the same destination the breadcrumb root
              does, so the app has one name for /. Outline, not primary: "Try
              again" is the action here. On the three screens where going back
              is the ONLY thing to do (/no-access, the 404), it is primary. */}
          <Link href="/" className={buttonClasses("outline")}>
            Back to Hub
          </Link>
        </div>
      </Card>
    </div>
  );
}
