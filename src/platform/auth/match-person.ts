import type { Person } from "@prisma/client";
import { prisma } from "@/platform/db";

/**
 * Login → Person resolution (spec §5). SECURITY LAYERING: the NextAuth signIn
 * callback is responsible for (a) verifying the token's tenant (tid) is Yale's
 * and (b) enforcing Person.status; this module only resolves identity. The
 * domain checks below are defense-in-depth, not the primary gate.
 */

export type LoginProfile = {
  entraObjectId?: string | null;
  upn?: string | null;
  email?: string | null;
};

/**
 * Yale UPNs look like "abc123@yale.edu" (NetID local part).
 * Alias addresses ("first.last@yale.edu") are not NetIDs, and
 * non-Yale domains never carry NetIDs.
 */
export function netIdFromUpn(upn: string): string | null {
  const [local, domain] = upn.split("@");
  if (domain?.toLowerCase() !== "yale.edu") return null;
  if (!local) return null;
  return /^[a-z]{2,8}[0-9]*$/i.test(local) ? local.toLowerCase() : null;
}

/**
 * Resolution order per spec §5. Matches via steps 2/3 link entraObjectId,
 * except when a Person is already bound to a different oid; in that case
 * linking is skipped and the stored oid remains authoritative.
 */
export async function resolvePersonForLogin(
  profile: LoginProfile
): Promise<Person | null> {
  // 1. Already linked
  if (profile.entraObjectId) {
    const linked = await prisma.person.findUnique({
      where: { entraObjectId: profile.entraObjectId },
    });
    if (linked) return linked;
  }

  // 2. NetID extracted from UPN
  const netId = profile.upn ? netIdFromUpn(profile.upn) : null;
  if (netId) {
    const byNetId = await prisma.person.findFirst({
      where: { netId: { equals: netId, mode: "insensitive" } },
    });
    if (byNetId) return link(byNetId, profile.entraObjectId);
  }

  // 3. Email against contactEmail, but ONLY when the claim is Yale-asserted
  //    (toLowerCase().endsWith("@yale.edu")). The trust gate lives entirely on the
  //    CLAIM side: contactEmail may be a personal address (e.g. gmail), and an Entra
  //    guest can carry an arbitrary external email claim. Matching only Yale-asserted
  //    claims means such a guest can never hijack a Person via their stored personal
  //    email. A person whose stored email is personal is reached instead via
  //    netId-from-UPN (step 2) or a linked oid (step 1). A genuine Yale claim
  //    (first.last@yale.edu) never equals a stored gmail address, so no cross-match
  //    is possible either direction.
  if (profile.email && profile.email.toLowerCase().endsWith("@yale.edu")) {
    const byEmail = await prisma.person.findFirst({
      where: { contactEmail: { equals: profile.email, mode: "insensitive" as const } },
    });
    if (byEmail) return link(byEmail, profile.entraObjectId);
  }

  // 4. No match
  return null;
}

/**
 * Per-request person lookup for session validation: a person who has been
 * OFFBOARDED (or deleted) after sign-in must lose access immediately, not
 * when their JWT expires (spec §5 "revocations take effect immediately").
 */
export async function getActivePerson(personId: string): Promise<Person | null> {
  const person = await prisma.person.findUnique({ where: { id: personId } });
  if (!person || person.status !== "ACTIVE") return null;
  return person;
}

async function link(person: Person, entraObjectId?: string | null): Promise<Person> {
  if (!entraObjectId || person.entraObjectId === entraObjectId) return person;
  // A Person already bound to a DIFFERENT oid is never re-linked here, because that would
  // let a colliding UPN/email claim hijack the record (and P2002 on the unique index).
  // The login still resolves to the person; the stored oid remains authoritative.
  if (person.entraObjectId) return person;
  return prisma.person.update({
    where: { id: person.id },
    data: { entraObjectId },
  });
}
