import { redirect } from "next/navigation";
import { auth } from "./auth";
import { can } from "@/platform/rbac/engine";

export type PersonSession = {
  personId: string;
  name: string | null;
  email: string | null;
};

/** For pages/actions that need a signed-in, matched person. Redirects otherwise. */
export async function requirePersonSession(): Promise<PersonSession> {
  const session = await auth();
  if (!session) redirect("/login");
  if (!session.personId) redirect("/welcome");
  return {
    personId: session.personId,
    name: session.user?.name ?? null,
    email: session.user?.email ?? null,
  };
}

/** Layout/page-level permission gate. */
export async function requirePermission(permission: string): Promise<PersonSession> {
  const person = await requirePersonSession();
  if (!(await can(person.personId, permission))) redirect("/hub");
  return person;
}
