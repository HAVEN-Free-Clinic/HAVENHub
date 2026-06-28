import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "./auth";
import { getActivePerson } from "./match-person";
import { can } from "@/platform/rbac/engine";
import { getModule } from "@/platform/modules/registry";
import { isAllowlistedPath } from "./onboarding-allowlist";
import { isGateClearedCached, markGateCleared } from "./onboarding-gate-cache";
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

  // Fast path: a recently-cleared person skips the ~9-query onboarding status.
  if (isGateClearedCached(personId)) return;

  // Exempt users (IT / super-admin) bypass the gate. Check this first: it reads
  // the per-request-cached permission set (already needed by the page and nav),
  // so it is near-free and lets exempt users skip getOnboardingStatus entirely
  // -- which otherwise fetches training, courses, and certificates regardless.
  if (await can(personId, EXEMPT_PERMISSION)) {
    markGateCleared(personId);
    return;
  }

  const status = await getOnboardingStatus(personId);
  if (!status.hasActiveTerm || status.onboarded) {
    markGateCleared(personId); // cache only the cleared decision
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
  if (!session) redirect("/login");
  if (!session.personId) redirect("/welcome");
  const person = await getActivePerson(session.personId);
  if (!person) redirect("/welcome");
  const result: PersonSession = {
    personId: person.id,
    name: person.name,
    email: person.contactEmail ?? session.user?.email ?? null,
    themePreference: person.themePreference ?? null,
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
 * Module route guard driven by the registry. Looks up the manifest and gates
 * on its accessPermission: when the module declares none, any signed-in matched
 * person may enter (requirePersonSession); otherwise the permission is required.
 * Throws for an unknown module id (programmer error, not a redirect).
 */
export async function requireModuleAccess(moduleId: string): Promise<PersonSession> {
  const mod = getModule(moduleId);
  if (!mod) throw new Error(`Unknown module id: ${moduleId}`);
  if (!mod.accessPermission) return requirePersonSession();
  return requirePermission(mod.accessPermission);
}
