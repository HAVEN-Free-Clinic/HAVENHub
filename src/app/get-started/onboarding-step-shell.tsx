import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { HavenMark } from "@/platform/ui/haven-mark";

/**
 * Shared chrome for the onboarding task sub-routes: a slim sticky top bar with a
 * back link, an "N of M complete" progress chip, and the HAVEN mark, over the
 * calm canvas. No AppShell / module nav -- that is what keeps a not-yet-cleared
 * volunteer inside the onboarding flow.
 *
 * backHref/backLabel default to the checklist. The course player passes the
 * course list instead, so a member steps back one level rather than jumping
 * past it. `wide` swaps the reading-width container for the same max-w-6xl the
 * app shell gives a page, so the SCORM iframe is not narrower here than it is
 * for a cleared member.
 */
export function OnboardingStepShell({
  title,
  description,
  completedCount,
  totalCount,
  backHref = "/get-started",
  backLabel = "Back to checklist",
  wide = false,
  children,
}: {
  title: string;
  description?: string;
  completedCount: number;
  totalCount: number;
  backHref?: string;
  backLabel?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const container = wide ? "max-w-6xl" : "max-w-3xl";
  return (
    <main className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-10 border-b border-border bg-canvas/85 backdrop-blur">
        <div className={`mx-auto flex ${container} items-center justify-between gap-4 px-6 py-3.5`}>
          <Link
            href={backHref}
            className="inline-flex items-center gap-2 text-[13px] font-semibold text-foreground-soft transition-colors hover:text-foreground"
          >
            <ArrowLeft aria-hidden className="h-4 w-4" />
            {backLabel}
          </Link>
          <div className="flex items-center gap-3">
            <span className="text-[12px] font-semibold text-muted-foreground">
              {completedCount} of {totalCount} complete
            </span>
            <HavenMark className="h-7 w-7 text-brand-fg" />
          </div>
        </div>
      </header>
      <div className={`mx-auto ${container} px-6 py-8`}>
        <h1 className="text-[22px] font-extrabold tracking-tight text-foreground">{title}</h1>
        {description && <p className="mt-1 text-[14px] leading-relaxed text-foreground-soft">{description}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
