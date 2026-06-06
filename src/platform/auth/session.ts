import { redirect } from "next/navigation";
import { auth } from "./auth";
import { getActivePerson } from "./match-person";
import { can } from "@/platform/rbac/engine";

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

/** Layout/page-level permission gate. NOTE: the redirect sink (/hub) must never itself be permission-gated, or this loops. */
export async function requirePermission(permission: string): Promise<PersonSession> {
  const person = await requirePersonSession();
  if (!(await can(person.personId, permission))) redirect("/hub");
  return person;
}
