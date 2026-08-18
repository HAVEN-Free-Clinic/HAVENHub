import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "./auth";
import { prisma } from "@/platform/db";
import { getActivePerson, resolvePersonForLogin } from "./match-person";
import { can, getEffectivePermissions } from "@/platform/rbac/engine";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getModule } from "@/platform/modules/registry";
import { canAccessModule } from "@/platform/modules/access";
import { isAllowlistedPath } from "./onboarding-allowlist";
import { isGateClearedCached, markGateCleared } from "./onboarding-gate-cache";
import { loginRedirectPath } from "./safe-next";
// The onboarding gate must run on every page render, including soft (client)
// navigations -- which re-render the page Server Component but NOT the root
// layout, so a layout-level gate is bypassable via in-app nav. requirePersonSession
// is the universal page chokepoint, so the gate lives here. This is the one
// sanctioned platform->module import: getOnboardingStatus aggregates data owned
// by the my-info, recruitment, and learning modules and has no platform home.
// eslint-disable-next-line no-restricted-imports, import/no-restricted-paths
import { getOnboardingStatus, EXEMPT_PERMISSION } from "@/modules/onboarding/services/onboarding";

export type PersonSession = {
  personId: string;
  name: string | null;
  email: string | null;
  themePreference: string | null;
  photoVersion: number;
  /** True when an admin has exempted this person from the content blocker gate. */
  blockerGateExempt: boolean;
};

/**
 * Hard gate: send a gated, not-yet-cleared person to /get-started. No-op when
 * there is no path context (server actions), on allowlisted paths, for exempt
 * users, when there is no active term, or when already onboarded. Runs from
 * requirePersonSession so it fires on every page render (incl. soft nav).
 */
async function enforceOnboarding(personId: string): Promise<void> {
  const path = (await headers()).get("x-pathname");
  if (!path || isAllowlistedPath(path)) return;

  // Resolve the active term up front (React-cache memoized, so near-free -- the page
  // and nav already resolve it). No active term means no onboarding requirement, and
  // nothing to key the cache on.
  const activeTerm = await getActiveTerm();
  if (!activeTerm) return;

  // Term-scoped cache key: activating a new term implicitly invalidates a person's
  // old-term "cleared" entry, so clearance is re-evaluated for the new term instead
  // of coasting on a stale personId-only entry for up to the cache TTL.
  const cacheKey = `${activeTerm.id}:${personId}`;

  // Fast path: a recently-cleared person skips the ~9-query onboarding status.
  if (isGateClearedCached(cacheKey)) return;

  // Exempt users (IT / super-admin) bypass the gate. Check this first: it reads
  // the per-request-cached permission set (already needed by the page and nav),
  // so it is near-free and lets exempt users skip getOnboardingStatus entirely
  // -- which otherwise fetches training, courses, and certificates regardless.
  if (await can(personId, EXEMPT_PERMISSION)) {
    markGateCleared(cacheKey);
    return;
  }

  // Nobody who is not ON the term's roster is onboarding onto it. The gate exists
  // to stop an uncleared VOLUNTEER from working clinic; a person with no ACTIVE
  // TermMembership in the live term has no shift to be cleared for, so there is
  // nothing to withhold.
  //
  // This is what lets an attending sign in at all. computeOnboardingForTerm builds
  // the `profile` and `hipaa` tasks unconditionally -- neither consults membership
  // -- so a faculty account with a Hub login but no roster row was handed two
  // blocking tasks and bounced to /get-started forever, with HIPAA in particular
  // being a credential Faculty Relations tracks on AttendingCredentialing and not
  // something the attending can satisfy here. Alumni and staff-only accounts land
  // in the same shape.
  //
  // Checked here rather than inside getOnboardingStatus on purpose: /get-started
  // and the dashboard still want the full checklist for anyone who asks for it.
  // This decides only whether the HARD gate fires. And it is a query, not an
  // allowlisted path -- admitting an (app) path is the trap ONBOARDING_ALLOWLIST
  // documents.
  const onRoster = await prisma.termMembership.findFirst({
    where: { personId, termId: activeTerm.id, status: "ACTIVE" },
    select: { id: true },
  });
  if (!onRoster) {
    markGateCleared(cacheKey);
    return;
  }

  const status = await getOnboardingStatus(personId);
  if (!status.hasActiveTerm || status.onboarded) {
    markGateCleared(cacheKey); // cache only the cleared decision
    return;
  }

  redirect("/get-started");
}

/**
 * For pages/actions that need a signed-in, matched, still-ACTIVE person.
 * Hits the DB on every call so offboarding revokes access immediately
 * even while the JWT is still valid. Redirects otherwise.
 */
export async function requirePersonSession(): Promise<PersonSession> {
  const session = await auth();
  if (!session) {
    // Carry the intended destination so an emailed deep link survives the SSO
    // round trip. proxy.ts stamps x-pathname on every request, including
    // server-action POSTs (Next posts an action to the current page's URL),
    // so this resolves to the real page path there too, not just on full
    // page loads.
    redirect(loginRedirectPath((await headers()).get("x-pathname")));
  }
  let personId = session.personId;
  if (!personId) {
    // The JWT stamps personId only at initial sign-in (auth.ts jwt `if (account)`)
    // and lives 7 days. A Yale-SSO applicant signs in with personId null; when
    // recruitment later promotes them to a Person, their existing session still
    // carries null, so they were bounced to /welcome ("contact IT / start an
    // application") on the designed happy path. Re-resolve the now-existing Person
    // from the verified applicantEmail sitting in the same token before giving up
    // (#65). Runs only for a null-personId session reaching a gated hub route (a
    // pure applicant browses /apply via getApplicantIdentity, not this path), and
    // matching is the same Yale-asserted resolver sign-in uses.
    if (session.applicantEmail) {
      const resolved = await resolvePersonForLogin({
        upn: session.applicantEmail,
        email: session.applicantEmail,
      });
      personId = resolved?.id ?? null;
    }
    if (!personId) redirect("/welcome");
  }
  const person = await getActivePerson(personId);
  if (!person) redirect("/welcome");
  const result: PersonSession = {
    personId: person.id,
    name: person.name,
    email: person.contactEmail ?? session.user?.email ?? null,
    themePreference: person.themePreference ?? null,
    photoVersion: person.photoVersion,
    blockerGateExempt: person.blockerGateExempt,
  };
  await enforceOnboarding(person.id);
  return result;
}

/**
 * Layout/page-level permission gate. Denied users land on /no-access -- a
 * friendly explanation -- rather than being silently bounced to the hub.
 * NOTE: the redirect sink (/no-access) must never itself be permission-gated,
 * or this loops; it is gated only by requirePersonSession via the (app) layout.
 */
export async function requirePermission(permission: string): Promise<PersonSession> {
  const person = await requirePersonSession();
  if (!(await can(person.personId, permission))) redirect("/no-access");
  return person;
}

/**
 * Like requirePermission, but passes when the person holds ANY of the listed
 * permissions. Denied users land on /no-access -- a friendly explanation --
 * rather than being silently bounced to the hub. Used where one page serves two
 * audiences (e.g. the term page: term admins and roster managers).
 */
export async function requireAnyPermission(permissions: string[]): Promise<PersonSession> {
  const person = await requirePersonSession();
  for (const permission of permissions) {
    if (await can(person.personId, permission)) return person;
  }
  redirect("/no-access");
}

/**
 * Module route guard driven by the registry. Looks up the manifest and gates on
 * it via canAccessModule: when the module declares no accessPermission, any
 * signed-in matched person may enter; otherwise accessPermission OR any of the
 * module's additionalAccessPermissions admits the viewer.
 * Throws for an unknown module id (programmer error, not a redirect).
 *
 * canAccessModule rather than a bare requirePermission(accessPermission) because
 * this guard and the nav MUST answer the same question. It consulted only
 * accessPermission, while the tile grid, the module row, and the module's own
 * ModuleNav all asked canAccessModule, so every module with
 * additionalAccessPermissions advertised itself to people this function then
 * bounced: a Learning Coordinator holding learning.manage_courses (but not
 * learning.access, which only the kind-scoped baselines hand out) saw a Learning
 * link and got /no-access from it -- exactly the audience
 * additionalAccessPermissions exists to admit (audit 14, AUTH-NAV-01). The same
 * dead-end-result shape has now been reported four times, so the fix belongs in
 * the one resolver both sides can share, not in each offending link.
 *
 * Landing on a module page is not the same as being able to do anything there:
 * every page keeps its own requirePermission, and a module's landing page shows
 * such a viewer whatever their grant actually opens (for Learning, the empty
 * "no assigned courses" list, which is the honest answer for a manager).
 */
export async function requireModuleAccess(moduleId: string): Promise<PersonSession> {
  const mod = getModule(moduleId);
  if (!mod) throw new Error(`Unknown module id: ${moduleId}`);
  if (!mod.accessPermission) return requirePersonSession();
  const person = await requirePersonSession();
  if (!canAccessModule(mod, await getEffectivePermissions(person.personId))) redirect("/no-access");
  return person;
}
