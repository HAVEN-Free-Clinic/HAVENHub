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
import { getActiveTerm } from "@/platform/terms/active-term";
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
  /** ACTIVE memberships in the active term, in department-code order. */
  memberships: { departmentCode: string; departmentName: string; kind: "DIRECTOR" | "VOLUNTEER" }[];
  /** The term those memberships are in, for the heading. Null when none is active. */
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

  const activeTerm = await getActiveTerm();
  const [memberships, languages] = await Promise.all([
    activeTerm
      ? prisma.termMembership.findMany({
          where: { personId, termId: activeTerm.id, status: "ACTIVE" },
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
    termName: activeTerm?.name ?? null,
  };
}
