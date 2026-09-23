/**
 * The identity half of a member's profile page.
 *
 * Deliberately a SUBSET of what /admin/people shows. A director looking up one
 * of their volunteers needs to reach them and to know what they can do on a
 * shift: contact details, affiliation, RN, verified languages, which departments
 * they are in. They do not need, and this never returns, the things that belong
 * to the people who administer records or handle incidents -- Epic id, date of
 * birth, sign-in activity, the do-not-rehire flag.
 *
 * Who may call it is decided by the page, through
 * platform/member-profile.canViewMemberProfile.
 */

import { prisma } from "@/platform/db";
import { getAccessTerm } from "@/platform/terms/access-term";
import { verifiedLanguagesByPerson } from "@/platform/languages";

export type MemberProfileBasics = {
  id: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  phone: string | null;
  pronouns: string | null;
  yaleAffiliation: string | null;
  gradYear: string | null;
  staffTitle: string | null;
  licensedRN: boolean;
  status: "ACTIVE" | "OFFBOARDED";
  photoVersion: number;
  /** ISO 639-1 codes the language reviewers have VERIFIED. Never self-reported. */
  verifiedLanguages: string[];
  /** ACTIVE memberships in the person's access term, in department-code order. */
  memberships: { departmentCode: string; departmentName: string; kind: "DIRECTOR" | "VOLUNTEER" }[];
  /**
   * The term those memberships are in, for the heading: the live term, or the
   * next one for a member only on that roster (see getAccessTerm), so an
   * incoming member reads as a member of their department rather than as
   * "No active membership". Null when no term resolves.
   */
  termName: string | null;
};

export async function getMemberProfileBasics(
  personId: string,
): Promise<MemberProfileBasics | null> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    select: {
      id: true,
      name: true,
      netId: true,
      contactEmail: true,
      phone: true,
      pronouns: true,
      yaleAffiliation: true,
      gradYear: true,
      staffTitle: true,
      licensedRN: true,
      status: true,
      photoVersion: true,
    },
  });
  if (!person) return null;

  const term = await getAccessTerm(personId);
  const [memberships, languages] = await Promise.all([
    term
      ? prisma.termMembership.findMany({
          where: { personId, termId: term.id, status: "ACTIVE" },
          select: { kind: true, department: { select: { code: true, name: true } } },
          orderBy: { department: { code: "asc" } },
        })
      : Promise.resolve([]),
    verifiedLanguagesByPerson([personId]),
  ]);

  return {
    ...person,
    status: person.status as "ACTIVE" | "OFFBOARDED",
    verifiedLanguages: languages.get(personId) ?? [],
    memberships: memberships.map((m) => ({
      departmentCode: m.department.code,
      departmentName: m.department.name,
      kind: m.kind as "DIRECTOR" | "VOLUNTEER",
    })),
    termName: term?.name ?? null,
  };
}
