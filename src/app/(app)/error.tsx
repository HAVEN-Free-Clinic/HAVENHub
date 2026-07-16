"use client";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { CaptureException } from "@/platform/posthog/capture-exception";

/**
 * Single error boundary for the whole authenticated (app) tree. It renders in
 * place of the failed page body but stays inside AppShell, so the toolbar and
 * navigation survive a thrown server component (a transient DB/Graph error, an
 * unexpected null) instead of falling through to Next's bare error screen.
 * `reset()` re-renders the segment to retry; the link is a guaranteed way back.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg py-12">
      <CaptureException error={error} />
      <Card className="text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-[13px] bg-critical-faint text-critical">
          <AlertTriangle aria-hidden className="h-6 w-6" />
        </span>
        <h1 className="mt-4 text-lg font-bold tracking-tight text-foreground">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We hit an unexpected error loading this page. Please try again. If the problem persists,
          contact the HAVEN IT team.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
          <Button onClick={() => reset()}>Try again</Button>
          <Link href="/" className={buttonClasses("outline")}>
            Back to home
          </Link>
        </div>
      </Card>
    </div>
  );
}
