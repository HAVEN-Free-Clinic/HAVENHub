import type { ReactNode } from "react";
import { requirePersonSession } from "@/platform/auth/session";
import { getActiveTerm } from "@/platform/terms/active-term";
import { reviewScope } from "@/modules/recruitment/services/review";
import { isInterviewPanelist } from "@/modules/recruitment/services/interviews";
import { recruitmentGlobalNav } from "@/modules/recruitment/nav";
import { AppShell } from "@/platform/ui/app-shell";
import { PostHogIdentify } from "@/platform/posthog/posthog-identify";
import { intercomAppId, isIntercomConfigured } from "@/platform/intercom/config";
import { IntercomMessenger } from "@/platform/intercom/messenger";

/**
 * Shared shell for every authenticated route. Owns the toolbar (AppShell) so it
 * mounts once and persists across cross-module navigation: only the page body
 * (and a module's own ModuleNav) reload on a tab switch. Public routes (login,
 * apply, onboard, welcome, get-started) live outside this group and keep their
 * own chrome.
 */
export default async function AppGroupLayout({ children }: { children: ReactNode }) {
  const person = await requirePersonSession();
  const [activeTerm, scope, isPanelist] = await Promise.all([
    getActiveTerm(),
    reviewScope(person.personId),
    isInterviewPanelist(person.personId),
  ]);
  // A department director reviews recruitment by scope (a derived directorship,
  // not a recruitment permission), so surface the Recruitment tab in the top nav
  // for them too -- matching the dashboard tile and the recruitment layout, which
  // both admit reviewers by scope. Anyone on an interview panel needs the tab
  // too, even holding neither recruitment.access nor a review scope (a "bare"
  // panelist added via listPanelistCandidates), or their "My interviews" item
  // has nowhere to appear. recruitmentGlobalNav derives extraModuleIds and
  // extraNavItems from the same two booleans so they cannot drift apart.
  const isRecruitmentReviewer = scope.all || scope.departmentCodes.length > 0;
  const { extraModuleIds, extraNavItems } = recruitmentGlobalNav({
    isReviewer: isRecruitmentReviewer,
    isPanelist,
  });
  // Support Messenger, authenticated routes only. Gated on the secret being set
  // too, so a workspace configured with just an app id stays off rather than
  // booting an unverified (impersonatable) Messenger.
  const supportAppId = isIntercomConfigured() ? intercomAppId() : null;
  return (
    <>
      {supportAppId ? <IntercomMessenger appId={supportAppId} /> : null}
      <PostHogIdentify
        personId={person.personId}
        name={person.name}
        email={person.email}
        termId={activeTerm?.id ?? null}
        termName={activeTerm?.name ?? null}
      />
      <AppShell
        userName={person.name}
        termLabel={activeTerm?.name ?? null}
        personId={person.personId}
        photoVersion={person.photoVersion}
        personThemePreference={person.themePreference}
        extraModuleIds={extraModuleIds}
        extraNavItems={extraNavItems}
      >
        {children}
      </AppShell>
    </>
  );
}
