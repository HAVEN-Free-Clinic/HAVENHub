"use client";
import { Button } from "@/platform/ui/button";
import { CaptureException } from "@/platform/posthog/capture-exception";

// Segment error boundary for the get-started gate. Its pages do several server
// reads (onboarding status, courses, training, certificates); if any throws, a
// not-yet-cleared member would otherwise hit Next's unstyled default 500 while
// blocked from the rest of the app. This gives them a branded retry and a next
// step instead. Mirrors src/app/apply/[slug]/error.tsx (client boundary + reset).
export default function GetStartedError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-6 py-16 text-center">
      <CaptureException error={error} />
      <h1 className="text-xl font-bold tracking-tight text-foreground">Something went wrong</h1>
      <p className="mt-2 text-muted-foreground">
        We could not load your onboarding checklist. Please try again. If the problem persists,
        contact your recruitment director.
      </p>
      <Button onClick={() => reset()} className="mt-6">Try again</Button>
    </main>
  );
}
