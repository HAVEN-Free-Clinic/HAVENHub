import { redirect } from "next/navigation";
import { auth } from "./auth";
import { getActivePerson } from "./match-person";
import { can } from "@/platform/rbac/engine";
import { getModule } from "@/platform/modules/registry";

export type PersonSession = {
  personId: string;
  name: string | null;
  email: string | null;
};

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
  return {
    personId: person.id,
    name: person.name,
    email: person.contactEmail ?? session.user?.email ?? null,
  };
}

/** Layout/page-level permission gate. NOTE: the redirect sink (the root hub page) must never itself be permission-gated, or this loops. */
export async function requirePermission(permission: string): Promise<PersonSession> {
  const person = await requirePersonSession();
  if (!(await can(person.personId, permission))) redirect("/");
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
