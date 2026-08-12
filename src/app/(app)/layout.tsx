import type { ReactNode } from "react";
import { requirePersonSession } from "@/platform/auth/session";
import { getActiveTerm } from "@/platform/terms/active-term";
import { reviewScope } from "@/modules/recruitment/services/review";
import { isInterviewPanelist } from "@/modules/recruitment/services/interviews";
import { recruitmentGlobalNav } from "@/modules/recruitment/nav";
import { AppShell } from "@/platform/ui/app-shell";
import { PostHogIdentify } from "@/platform/posthog/posthog-identify";
import { resolveSupportAppId } from "@/platform/intercom/config";
import { IntercomMessenger } from "@/platform/intercom/messenger";
import { mintMessengerTokenForSession, type MintResult } from "@/modules/support/services/messenger-token";
import { BlockerGate } from "@/platform/intercom/blocker-gate";
import { shouldMountBlockerGate } from "@/platform/intercom/gate-mount";
import { getSupportContact } from "@/platform/branding/support";
import { getSetting } from "@/platform/settings/service";
import { log, errorAttrs } from "@/platform/logging";

/**
 * Shared shell for every authenticated route. Owns the toolbar (AppShell) so it
 * mounts once and persists across cross-module navigation: only the page body
 * (and a module's own ModuleNav) reload on a tab switch. Public routes (login,
 * apply, onboard, welcome, get-started) live outside this group and keep their
 * own chrome.
 */
export default async function AppGroupLayout({ children }: { children: ReactNode }) {
  const person = await requirePersonSession();
  const [activeTerm, scope, isPanelist, supportContact, blockerGateEnabled, messengerToken] =
    await Promise.all([
      getActiveTerm(),
      reviewScope(person.personId),
      isInterviewPanelist(person.personId),
      getSupportContact(),
      getSetting<boolean>("support.blockerGateEnabled"),
      // mintMessengerTokenForSession only converts a recognized DB-unreachable
      // shape into a clean refusal; everything else (an unrecognized DB error
      // shape, a jose failure, a bug in getEffectivePermissions) rethrows. Its
      // only caller used to be the token route, where an unhandled rejection
      // is a contained 500 on /api/support/messenger-token alone. Its second
      // caller is this Promise.all, where an unhandled rejection would reject
      // the ENTIRE layout render for every signed-in member over a
      // support-only failure. Contained here: log it and degrade to a
      // token-less render, which IntercomMessenger already falls back to
      // fetching for. Support degrading is acceptable; the hub failing to
      // render is not.
      mintMessengerTokenForSession().catch((err): MintResult => {
        log.error(
          "[intercom] layout mint failed unexpectedly; degrading to a token-less render",
          errorAttrs(err)
        );
        return { ok: false, reason: "db_unreachable" };
      }),
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
  // Support Messenger, authenticated routes only. resolveSupportAppId() gates on
  // the secret being set as well as the app id, so a workspace configured with
  // only an app id stays off rather than booting an unverified (impersonatable)
  // Messenger. It is a shared helper because the Messenger now mounts on six
  // surfaces, and each re-deriving "is Intercom on" is how one of them ends up
  // booting unverified.
  const supportAppId = resolveSupportAppId();
  const mountBlockerGate = shouldMountBlockerGate({
    supportAppId,
    gateEnabled: blockerGateEnabled,
    personExempt: person.blockerGateExempt,
  });
  return (
    <>
      {/* The Messenger mounts on supportAppId alone. The gate exists only to protect
          the Messenger, so it must never outlive it, and turning the integration off
          turns the gate off in the same motion. That is also what keeps a hard block
          out of CI, the e2e suite, preview, and demo, none of which set
          NEXT_PUBLIC_INTERCOM_APP_ID.

          The gate carries two further, one-way conditions on top, both subtracting
          only from the gate and never from the Messenger. First, the runtime kill
          switch: a blocker and an Intercom outage at the network layer look the
          same from the browser, so an outage would gate every member at once, and
          NEXT_PUBLIC_INTERCOM_APP_ID is inlined at build time and cannot be unset
          without a rebuild. The setting is read here through getSetting, so
          flipping it off in /admin/settings stands the gate down within its 30s
          cache. Second, a per-person exemption, for someone correctly detected as
          blocked who cannot comply (a device or network they do not control).
          Both conditions are one-way on purpose: they stop the app blocking people
          WITHOUT taking support away from the ones who can still reach it. The
          combined rule lives in shouldMountBlockerGate rather than here, so the
          three switches get names and tests instead of being ANDed inline. */}
      {supportAppId ? (
        <>
          {/* mode="identified", and NO requireActiveMembership: a member between
              terms (no current ACTIVE TermMembership row) still signs into the
              hub and must still be identified -- that carve-out is the whole
              reason "between terms" is not an offboarded state (see
              cross-term-overlap-model). The /apply portal is the one surface
              that DOES add the active-membership restriction (see its layout
              and the mint's doc comment), precisely because it is public-facing
              and reachable by Yale accounts with no Person at all -- a case
              that cannot arise here, behind requirePersonSession above.

              That absence is also why passing initialToken is safe HERE and
              nowhere else yet: a server-minted token sets `booted` at mount, so
              IntercomMessenger's client-side 401/403-to-visitor fallback cannot
              fire. With no gate on this surface there is nothing for it to
              enforce. Wiring initialToken into a surface that DOES gate means
              the gate must run at mint time, or a stranger boots identified. */}
          <IntercomMessenger
            appId={supportAppId}
            mode="identified"
            initialToken={messengerToken.ok ? messengerToken : null}
          />
          {/* shouldMountBlockerGate already returns false without an app id, so
              the supportAppId check above is the only one this needs. */}
          {mountBlockerGate ? (
            <BlockerGate appId={supportAppId} supportEmail={supportContact.email} />
          ) : null}
        </>
      ) : null}
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
