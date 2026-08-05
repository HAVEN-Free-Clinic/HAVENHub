/**
 * Recognizing a returning alum in the apply portal.
 *
 * A person who served a past term and was then offboarded cannot sign in as a
 * member: auth.ts's resolveEntraLogin returns null for Person.status
 * "OFFBOARDED", so a Yale SSO sign-in admits them with personId null and they
 * land in the portal as a prospective applicant, indistinguishable from someone
 * who has never heard of the clinic. Their record is not lost -- promotion.ts
 * re-matches them by netId/contactEmail and reactivates them when an acceptance
 * is promoted -- but nothing told them that, so the portal read as "we have no
 * idea who you are".
 *
 * This module closes that gap on the DISPLAY side only. It grants nothing: the
 * lookup runs the same trust gate as sign-in (see findMemberRecordByClaim) and
 * its result is used to greet the applicant and set expectations, never to
 * authorize. Hub access still requires Person.status ACTIVE through
 * requirePersonSession.
 */

import { prisma } from "@/platform/db";
import { findMemberRecordByClaim } from "@/platform/auth/match-person";
import type { ApplicantIdentity } from "./portal-auth";

export type ReturningMember = {
  personId: string;
  name: string;
  /**
   * True when the record exists but no longer carries hub access -- the alum
   * case this module exists for. False for an ACTIVE person who happens to be
   * in the portal without a member session (e.g. signed in by portal link).
   */
  isFormerMember: boolean;
  /** The most recent term they served, with the departments they served in. */
  lastTerm: { code: string; name: string; departments: string[] } | null;
};

/**
 * The existing Person record behind an applicant identity, if the verified
 * claim names one. Returns null for an identity that already resolved to a
 * member session (nothing to recognize) and for a claim that names nobody.
 *
 * Note: ApplicantIdentity carries no Entra object id, so this resolves by
 * NetID-from-UPN and Yale-asserted email only. An alum reachable ONLY by a
 * linked oid is not recognized; in practice such a record also carries the
 * netId that matched it at first sign-in.
 */
export async function findReturningMember(
  identity: ApplicantIdentity,
): Promise<ReturningMember | null> {
  // Already recognized: the session carries the Person, so the portal greets
  // them from it directly and there is nothing to reconnect.
  if (identity.personId) return null;

  const person = await findMemberRecordByClaim({
    // The verified portal address doubles as the UPN candidate: netIdFromUpn
    // accepts it only when it is genuinely NetID-shaped and Yale-domained, and
    // the email branch applies its own Yale-asserted gate. Passing it as both
    // therefore widens nothing.
    upn: identity.email,
    email: identity.email,
  });
  if (!person) return null;

  const memberships = await prisma.termMembership.findMany({
    where: { personId: person.id, status: "ACTIVE" },
    select: { department: { select: { name: true } }, term: { select: { code: true, name: true, startDate: true } } },
    orderBy: { term: { startDate: "desc" } },
  });

  const mostRecent = memberships[0]?.term ?? null;
  const lastTerm = mostRecent
    ? {
        code: mostRecent.code,
        name: mostRecent.name,
        departments: [
          ...new Set(
            memberships
              .filter((m) => m.term.code === mostRecent.code)
              .map((m) => m.department.name),
          ),
        ].sort(),
      }
    : null;

  return {
    personId: person.id,
    name: person.name,
    isFormerMember: person.status !== "ACTIVE",
    lastTerm,
  };
}
