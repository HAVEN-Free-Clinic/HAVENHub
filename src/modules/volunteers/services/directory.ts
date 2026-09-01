/**
 * The clinic-wide people directory: how many people the clinic has, where they
 * sit, and how to reach them.
 *
 * Scoped to the ACTIVE term throughout. A directory of "who is here" is a
 * statement about now, and a person's departments, role, and even whether they
 * count at all are all term-scoped facts (TermMembership), so every query here
 * takes a termId rather than reading the clock itself.
 *
 * ---------------------------------------------------------------------------
 * Seats vs people, the one thing to get right
 * ---------------------------------------------------------------------------
 * A TermMembership row is a SEAT, not a person. Someone who directs Nursing and
 * volunteers in Triage holds two of them, and the Hub has always allowed that.
 * So two different true numbers exist for "how many volunteers do we have", and
 * a page that shows one while implying the other is simply wrong:
 *
 *   - `summary` counts DISTINCT PEOPLE. Its directors + volunteers can exceed
 *     its activePeople, because that same person is genuinely both.
 *   - `departmentBreakdown` counts SEATS. Its column totals can exceed
 *     `summary`'s people counts, for the same reason.
 *
 * Neither is a rounding error to be smoothed over; they answer different
 * questions ("how many humans" vs "how many roles are filled"). The page labels
 * both and states the gap. Do not "fix" one to match the other.
 *
 * Trusts its caller for permissions: the page and the export route both gate on
 * volunteers.view_directory.
 */

import { prisma } from "@/platform/db";
import { accountEmailForPerson } from "@/platform/auth/match-person";

/** Only ACTIVE people in ACTIVE memberships are on the roster. A REMOVED
 *  membership is a seat someone has left; an OFFBOARDED person has left the
 *  clinic. Both are excluded from every count and list in this module. */
const ON_ROSTER = { status: "ACTIVE" as const, person: { status: "ACTIVE" as const } };

export type DirectorySummary = {
  /** Distinct people holding at least one active membership this term. */
  activePeople: number;
  /** Distinct people holding at least one DIRECTOR seat. Overlaps `volunteers`. */
  directors: number;
  /** Distinct people holding at least one VOLUNTEER seat. Overlaps `directors`. */
  volunteers: number;
  /** Distinct people holding BOTH a director and a volunteer seat, i.e. exactly
   *  the overlap that makes directors + volunteers exceed activePeople. Shown so
   *  the page can explain the discrepancy instead of leaving it to look wrong. */
  bothRoles: number;
  /** Departments with at least one person on the roster this term. */
  departmentsStaffed: number;
  /** Active attendings. Faculty: no membership, no department, counted apart. */
  attendings: number;
};

export type DepartmentBreakdownRow = {
  departmentId: string;
  code: string;
  name: string;
  /** Seats, not people -- see the module comment. */
  directors: number;
  volunteers: number;
  total: number;
};

export type DirectoryPerson = {
  id: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  phone: string | null;
  /** One entry per seat this person holds this term, department code ascending. */
  seats: { departmentCode: string; kind: "DIRECTOR" | "VOLUNTEER" }[];
};

export type DirectoryAttending = {
  id: string;
  fullName: string;
  credentials: string | null;
  specialty: string | null;
  email: string | null;
  phone: string | null;
};

/** Filters shared by the on-screen list and the CSV export, so what downloads is
 *  always exactly what was on screen. */
export type DirectoryFilters = {
  departmentId?: string;
  kind?: "DIRECTOR" | "VOLUNTEER";
  /** Matches name, NetID, or contact email, case-insensitively. */
  q?: string;
};

/**
 * Headline counts. Every figure is a count of DISTINCT PEOPLE except
 * `departmentsStaffed` and `attendings` -- see the module comment.
 *
 * Deliberately five small counts rather than one clever query: `_count` with
 * `distinct` does not compose with the role split, and the alternative (pulling
 * every membership and reducing in memory) loads the whole roster to produce
 * six integers.
 */
export async function directorySummary(termId: string | null): Promise<DirectorySummary> {
  // Attendings are not term-scoped: the roster predates Hub terms and a doctor
  // covers clinic whether or not a term is active, so this count stands even
  // when there is no active term at all.
  const attendings = await prisma.attending.count({ where: { isActive: true } });
  if (!termId) {
    return {
      activePeople: 0,
      directors: 0,
      volunteers: 0,
      bothRoles: 0,
      departmentsStaffed: 0,
      attendings,
    };
  }

  const seatWhere = { termId, ...ON_ROSTER };
  const [activePeople, directors, volunteers, bothRoles, departments] = await Promise.all([
    prisma.person.count({ where: { status: "ACTIVE", memberships: { some: seatWhere } } }),
    prisma.person.count({
      where: { status: "ACTIVE", memberships: { some: { ...seatWhere, kind: "DIRECTOR" } } },
    }),
    prisma.person.count({
      where: { status: "ACTIVE", memberships: { some: { ...seatWhere, kind: "VOLUNTEER" } } },
    }),
    prisma.person.count({
      where: {
        status: "ACTIVE",
        AND: [
          { memberships: { some: { ...seatWhere, kind: "DIRECTOR" } } },
          { memberships: { some: { ...seatWhere, kind: "VOLUNTEER" } } },
        ],
      },
    }),
    prisma.termMembership.findMany({
      where: seatWhere,
      select: { departmentId: true },
      distinct: ["departmentId"],
    }),
  ]);

  return {
    activePeople,
    directors,
    volunteers,
    bothRoles,
    departmentsStaffed: departments.length,
    attendings,
  };
}

/**
 * Per-department seat counts, every department in the clinic ordered by code.
 *
 * Departments with nobody in them are KEPT, at zero. An empty department is a
 * staffing fact an Executive Director wants to see; dropping the row would hide
 * exactly the thing worth noticing.
 */
export async function departmentBreakdown(termId: string | null): Promise<DepartmentBreakdownRow[]> {
  const departments = await prisma.department.findMany({
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  if (!termId) {
    return departments.map((d) => ({
      departmentId: d.id,
      code: d.code,
      name: d.name,
      directors: 0,
      volunteers: 0,
      total: 0,
    }));
  }

  const grouped = await prisma.termMembership.groupBy({
    by: ["departmentId", "kind"],
    where: { termId, ...ON_ROSTER },
    _count: { _all: true },
  });
  const counts = new Map<string, { directors: number; volunteers: number }>();
  for (const row of grouped) {
    const entry = counts.get(row.departmentId) ?? { directors: 0, volunteers: 0 };
    if (row.kind === "DIRECTOR") entry.directors = row._count._all;
    else entry.volunteers = row._count._all;
    counts.set(row.departmentId, entry);
  }

  return departments.map((d) => {
    const entry = counts.get(d.id) ?? { directors: 0, volunteers: 0 };
    return {
      departmentId: d.id,
      code: d.code,
      name: d.name,
      directors: entry.directors,
      volunteers: entry.volunteers,
      total: entry.directors + entry.volunteers,
    };
  });
}

/** The Prisma filter shared by the paged list and the unpaged export, so the two
 *  can never select different people for the same filters on screen. */
function peopleWhere(termId: string, filters: DirectoryFilters) {
  const seat = {
    termId,
    ...ON_ROSTER,
    ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
  };
  const q = filters.q?.trim();
  return {
    status: "ACTIVE" as const,
    memberships: { some: seat },
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { netId: { contains: q, mode: "insensitive" as const } },
            { contactEmail: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
}

/**
 * The seat selector, matching `peopleWhere`'s membership filter.
 *
 * It has to be applied to the nested read as well as the outer `where`: the
 * outer clause decides WHICH PEOPLE come back, the nested one decides WHICH
 * SEATS are shown for them. Without it, filtering to one department returned
 * the right people but listed all of their departments, so a Nursing filter
 * quietly displayed each person's Triage seat too.
 */
function seatSelect(termId: string, filters: DirectoryFilters) {
  return {
    where: {
      termId,
      ...ON_ROSTER,
      ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
      ...(filters.kind ? { kind: filters.kind } : {}),
    },
    select: { kind: true, department: { select: { code: true } } },
    orderBy: [{ department: { code: "asc" as const } }],
  };
}

function toDirectoryPerson(row: {
  id: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  phone: string | null;
  memberships: { kind: string; department: { code: string } }[];
}): DirectoryPerson {
  return {
    id: row.id,
    name: row.name,
    netId: row.netId,
    contactEmail: row.contactEmail,
    phone: row.phone,
    seats: row.memberships.map((m) => ({
      departmentCode: m.department.code,
      kind: m.kind as "DIRECTOR" | "VOLUNTEER",
    })),
  };
}

/** One page of the filtered roster, ordered by name. */
export async function directoryPeople(
  termId: string | null,
  filters: DirectoryFilters,
  page: number,
  pageSize: number,
): Promise<{ rows: DirectoryPerson[]; total: number; page: number; pageCount: number }> {
  if (!termId) return { rows: [], total: 0, page: 1, pageCount: 1 };
  const where = peopleWhere(termId, filters);
  const [total, rows] = await Promise.all([
    prisma.person.count({ where }),
    prisma.person.findMany({
      where,
      select: {
        id: true,
        name: true,
        netId: true,
        contactEmail: true,
        phone: true,
        memberships: seatSelect(termId, filters),
      },
      orderBy: { name: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return {
    rows: rows.map(toDirectoryPerson),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** The whole filtered roster, unpaged. Feeds the CSV export only: an export that
 *  silently stopped at the current page would be the worst kind of wrong. */
export async function directoryPeopleAll(
  termId: string | null,
  filters: DirectoryFilters,
): Promise<DirectoryPerson[]> {
  if (!termId) return [];
  const rows = await prisma.person.findMany({
    where: peopleWhere(termId, filters),
    select: {
      id: true,
      name: true,
      netId: true,
      contactEmail: true,
      phone: true,
      memberships: seatSelect(termId, filters),
    },
    orderBy: { name: "asc" },
  });
  return rows.map(toDirectoryPerson);
}

/** Active attendings, ordered by name. Faculty hold no membership and belong to
 *  no department, so they are never filtered by either. */
export async function directoryAttendings(): Promise<DirectoryAttending[]> {
  const rows = await prisma.attending.findMany({
    where: { isActive: true },
    select: {
      id: true,
      fullName: true,
      credentials: true,
      email: true,
      phone: true,
      specialty: { select: { name: true } },
    },
    orderBy: { fullName: "asc" },
  });
  return rows.map((a) => ({
    id: a.id,
    fullName: a.fullName,
    credentials: a.credentials,
    specialty: a.specialty?.name ?? null,
    email: a.email,
    phone: a.phone,
  }));
}

/** The address to reach a directory person at, resolved the same way every other
 *  export in the app resolves it. Re-exported so the CSV builder and the page
 *  agree without either importing from the auth layer directly. */
export { accountEmailForPerson };
