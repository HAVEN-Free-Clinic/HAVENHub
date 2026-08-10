import type { ReactNode } from "react";
import { CopyrightNotice } from "@/platform/ui/app-footer";

/**
 * Carries the copyright notice across the whole onboarding flow: the checklist
 * and every task sub-route beneath it. Lives here rather than inside
 * OnboardingStepShell so that component stays a pure presentational unit its
 * tests can render synchronously -- CopyrightNotice is async and reads settings.
 *
 * Deliberately adds no chrome of its own: the pages own their full-height mains
 * (a grid with a brand rail on the checklist, a sticky top bar on each step),
 * and the notice closes the page out beneath them.
 */
export default function GetStartedLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <div className="bg-canvas px-6 pb-8">
        <CopyrightNotice />
      </div>
    </>
  );
}
