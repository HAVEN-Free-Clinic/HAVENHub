import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { HavenMark } from "@/platform/ui/haven-mark";

/**
 * Shared chrome for the onboarding task sub-routes: a slim sticky top bar with a
 * "Back to checklist" link, an "N of M complete" progress chip, and the HAVEN
 * mark, over the calm canvas. No AppShell / module nav -- that is what keeps a
 * not-yet-cleared volunteer inside the onboarding flow.
 */
export function OnboardingStepShell({
  title,
  description,
  completedCount,
  totalCount,
  children,
}: {
  title: string;
  description?: string;
  completedCount: number;
  totalCount: number;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-10 border-b border-border bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-3.5">
          <Link
            href="/get-started"
            className="inline-flex items-center gap-2 text-[13px] font-semibold text-foreground-soft transition-colors hover:text-foreground"
          >
            <ArrowLeft aria-hidden className="h-4 w-4" />
            Back to checklist
          </Link>
          <div className="flex items-center gap-3">
            <span className="text-[12px] font-semibold text-muted-foreground">
              {completedCount} of {totalCount} complete
            </span>
            <HavenMark className="h-7 w-7 text-brand-fg" />
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="text-[22px] font-extrabold tracking-tight text-foreground">{title}</h1>
        {description && <p className="mt-1 text-[14px] leading-relaxed text-foreground-soft">{description}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
