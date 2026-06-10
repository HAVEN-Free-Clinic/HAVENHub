/**
 * ITCM admin service: Epic request data queries.
 *
 * Provides the data layer for the Epic request PDF generator:
 *   - listDepartmentsWithMembers: all active departments with their active
 *     term members (directors and volunteers), used to populate the person
 *     selector and find Epic ID mirror candidates.
 *   - findMirrorPerson: given a department and role, finds another active
 *     member in that department who already has an epicId set. Used to
 *     auto-populate the "person with similar job functions" fields.
 *   - getPeopleForRequest: returns full person records for a set of ids,
 *     used to build the spreadsheet rows for bulk requests.
 *
 * Permission checks are NOT this service's concern — the page gates via
 * requirePermission("admin.access"). Services trust their callers.
 */

import type { Person, Department } from "@prisma/client";
import { prisma } from "@/platform/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemberLite = {
  id: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  epicId: string | null;
  kind: "DIRECTOR" | "VOLUNTEER";
};

export type DepartmentWithMembers = {
  department: Department;
  directors: MemberLite[];
  volunteers: MemberLite[];
};

// ---------------------------------------------------------------------------
// listDepartmentsWithMembers
// ---------------------------------------------------------------------------

/**
 * Returns all active departments with their active-term members.
 *
 * Only includes departments that have at least one ACTIVE membership in the
 * current term. Members are sorted by name within each role group. Used to
 * populate the person selector on the Epic request page.
 */
export async function listDepartmentsWithMembers(): Promise<DepartmentWithMembers[]> {
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
  if (!activeTerm) return [];

  const memberships = await prisma.termMembership.findMany({
    where: { termId: activeTerm.id, status: "ACTIVE" },
    include: {
      person: true,
      department: true,
    },
    orderBy: [{ department: { code: "asc" } }, { person: { name: "asc" } }],
  });

  // Group by department.
  const byDept = new Map<string, DepartmentWithMembers>();
  for (const m of memberships) {
    if (!byDept.has(m.departmentId)) {
      byDept.set(m.departmentId, {
        department: m.department,
        directors: [],
        volunteers: [],
      });
    }
    const entry = byDept.get(m.departmentId)!;
    const member: MemberLite = {
      id: m.person.id,
      name: m.person.name,
      netId: m.person.netId,
      contactEmail: m.person.contactEmail,
      epicId: m.person.epicId,
      kind: m.kind,
    };
    if (m.kind === "DIRECTOR") {
      entry.directors.push(member);
    } else {
      entry.volunteers.push(member);
    }
  }

  return [...byDept.values()];
}

// ---------------------------------------------------------------------------
// findMirrorPerson
// ---------------------------------------------------------------------------

/**
 * Finds a reference person for the "Epic ID to mirror" field.
 *
 * Searches the active term for another ACTIVE member in the same department
 * with the same role (director mirrors director, volunteer mirrors volunteer)
 * who already has an epicId set. Returns the first match sorted by name, or
 * null if none exists.
 *
 * Directors should mirror directors; volunteers should mirror volunteers.
 * This keeps access levels appropriate for the role.
 */
export async function findMirrorPerson(
  departmentId: string,
  kind: "DIRECTOR" | "VOLUNTEER",
  excludePersonId?: string
): Promise<{ name: string; epicId: string } | null> {
  const activeTerm = await prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
  if (!activeTerm) return null;

  const membership = await prisma.termMembership.findFirst({
    where: {
      termId: activeTerm.id,
      departmentId,
      kind,
      status: "ACTIVE",
      personId: excludePersonId ? { not: excludePersonId } : undefined,
      person: { epicId: { not: null } },
    },
    include: { person: { select: { name: true, epicId: true } } },
    orderBy: { person: { name: "asc" } },
  });

  if (!membership?.person.epicId) return null;
  return { name: membership.person.name, epicId: membership.person.epicId };
}

// ---------------------------------------------------------------------------
// getPeopleByIds
// ---------------------------------------------------------------------------

/**
 * Returns full person records for a set of person ids.
 *
 * Used to build spreadsheet rows for bulk requests — the page collects
 * selected person ids and passes them here to get name, email, netId, epicId.
 */
export async function getPeopleByIds(ids: string[]): Promise<Person[]> {
  return prisma.person.findMany({
    where: { id: { in: ids } },
    orderBy: { name: "asc" },
  });
}