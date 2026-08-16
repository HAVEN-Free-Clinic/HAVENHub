import type { ReactNode } from "react";
import { CopyrightNotice } from "@/platform/ui/app-footer";
import { resolveSupportAppId } from "@/platform/intercom/config";
import { IntercomMessenger } from "@/platform/intercom/messenger";

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
  const supportAppId = resolveSupportAppId();
  return (
    <>
      {/* mode="identified", no requireActiveMembership: every route under
          /get-started is reached through requirePersonSession (see
          get-started/page.tsx and the onboarding-gate redirect target), so a
          Person always exists here. No BlockerGate -- that stays (app)-only
          by design, see blocker-gate.tsx. */}
      {supportAppId ? <IntercomMessenger appId={supportAppId} mode="identified" /> : null}
      {children}
      <div className="bg-canvas px-6 pb-8">
        <CopyrightNotice />
      </div>
    </>
  );
}
