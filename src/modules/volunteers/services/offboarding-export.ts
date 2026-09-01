/**
 * CSV export of people to remove from Teams.
 *
 * The app holds no Graph permission to manage team or group membership (its
 * scopes are Mail.Send, Channel.ReadBasic.All, Chat.Create, ChatMessage.Send),
 * so removal is a manual task and this export is the hand-off.
 *
 * Two scopes share one row builder:
 *   selection       - exactly the people picked on the Transition tab, so the
 *                     list can be pulled before or after flagging.
 *   offboarded-term - everyone already OFFBOARDED who held a place in the active
 *                     term, which is the population whose Teams access should
 *                     already be gone.
 *
 * `now` is a parameter rather than a call to the clock so the filename is
 * deterministic in tests.
 *
 * Trusts its caller for permissions: the route gates on
 * volunteers.manage_offboarding.
 */

import { prisma } from "@/platform/db";
import { toCsv } from "@/platform/csv";
import { accountEmailForPerson } from "@/platform/auth/match-person";
import { getActiveTerm } from "@/platform/terms/active-term";

export type ExportRequest =
  | { scope: "selection"; personIds: string[] }
  | { scope: "offboarded-term" };

const HEADERS = ["Name", "Email", "NetID", "Contact email", "Departments", "Role"];

type PersonRow = {
  id: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  memberships: { kind: string; department: { code: string } }[];
};

function buildRow(person: PersonRow): string[] {
  const codes = [...new Set(person.memberships.map((m) => m.department.code))].sort();
  const role = person.memberships.some((m) => m.kind === "DIRECTOR") ? "DIRECTOR" : "VOLUNTEER";
  return [
    person.name,
    // netId@yale.edu is the Teams account this export exists to remove; the
    // stored contact address is the fallback. Shared with the directory export
    // so the two never disagree about a person's address.
    accountEmailForPerson(person),
    person.netId ?? "",
    person.contactEmail ?? "",
    codes.join(";"),
    role,
  ];
}

export async function buildOffboardingCsv(
  input: ExportRequest,
  now: Date
): Promise<{ filename: string; csv: string; rowCount: number }> {
  const activeTerm = await getActiveTerm();

  let people: PersonRow[] = [];

  if (activeTerm) {
    const membershipFilter =
      input.scope === "selection"
        ? { termId: activeTerm.id, status: "ACTIVE" as const }
        : { termId: activeTerm.id, status: "REMOVED" as const };

    people = await prisma.person.findMany({
      where:
        input.scope === "selection"
          ? { id: { in: input.personIds } }
          : {
              status: "OFFBOARDED",
              memberships: { some: { termId: activeTerm.id, status: "REMOVED" } },
            },
      select: {
        id: true,
        name: true,
        netId: true,
        contactEmail: true,
        memberships: {
          where: membershipFilter,
          select: { kind: true, department: { select: { code: true } } },
        },
      },
      orderBy: { name: "asc" },
    });
  } else if (input.scope === "selection") {
    // No active term means there is no term-scoped membership to describe, but
    // the selected people are still real and still need removing, so export
    // them with a blank department and a VOLUNTEER role rather than an empty
    // file. Fetched without the memberships relation at all (rather than a
    // Prisma filter engineered to match nothing) since there is no term to
    // scope it to.
    const basePeople = await prisma.person.findMany({
      where: { id: { in: input.personIds } },
      select: { id: true, name: true, netId: true, contactEmail: true },
      orderBy: { name: "asc" },
    });
    people = basePeople.map((p) => ({ ...p, memberships: [] }));
  }

  const rows = people.map(buildRow);
  const day = now.toISOString().slice(0, 10);

  return {
    filename: `haven-offboarding-${activeTerm?.code ?? "no-term"}-${day}.csv`,
    // Person.name and Person.contactEmail are user-supplied (the apply wizard
    // takes names from anonymous applicants; /my-info lets members edit their
    // own record) and this file is opened in Excel, so guard against
    // spreadsheet formula injection.
    csv: toCsv(HEADERS, rows, { neutralizeFormulas: true }),
    rowCount: rows.length,
  };
}
