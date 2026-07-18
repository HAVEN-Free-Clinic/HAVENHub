"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Button, buttonClasses } from "@/platform/ui/button";
import { Card } from "@/platform/ui/card";
import { CaptureException } from "@/platform/posthog/capture-exception";

/**
 * Scoped error boundary for a single applicant's detail page. The page awaits a
 * stack of data loads and renders a lot of conditional review/decision UI, so a
 * throw anywhere in that chain would otherwise bubble to the (app) boundary and
 * replace the whole page body. Catching it here keeps the surrounding cycle
 * layout (breadcrumbs, nav) intact and offers a direct way back to the roster,
 * so one bad record degrades gracefully instead of blanking the page.
 */
export default function ApplicantDetailError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const params = useParams<{ id: string }>();
  const applicantsHref = params?.id ? `/recruitment/cycles/${params.id}/applicants` : "/recruitment";
  return (
    <div className="mx-auto max-w-lg py-12">
      <CaptureException error={error} />
      <Card className="text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-[13px] bg-critical-faint text-critical">
          <AlertTriangle aria-hidden className="h-6 w-6" />
        </span>
        <h1 className="mt-4 text-lg font-bold tracking-tight text-foreground">Couldn&apos;t load this applicant</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We hit an unexpected error loading this applicant. Any decision you just recorded was still saved.
          Please try again, or head back to the applicant list. If the problem persists, contact support.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
          <Button onClick={() => reset()}>Try again</Button>
          <Link href={applicantsHref} className={buttonClasses("outline")}>
            Back to applicants
          </Link>
        </div>
      </Card>
    </div>
  );
}
