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
 * ---------------------------------------------------------------------------
 * Scope
 * ---------------------------------------------------------------------------
 * Two audiences read this module. An Executive Director holds the clinic-wide
 * `volunteers.view_directory` and sees everything; a department director holds
 * the scoped `volunteers.view_directory_own_dept` and sees the departments they
 * direct. That difference is a `DirectoryScope`, threaded through EVERY query
 * here rather than applied by the page, so the on-screen roster, the counts
 * above it, and the CSV export can never disagree about who is in scope --
 * which is the failure mode that turns a scoped view into a leak.
 *
 * `null` means clinic-wide. It is never the default: every caller states it.
 *
 * Trusts its caller to have resolved that scope with {@link directoryScopeFor},
 * and to have gated the request on one of the two permissions.
 */

import { prisma } from "@/platform/db";
import { accountEmailForPerson } from "@/platform/auth/match-person";
import { can, permissionDepartmentIds } from "@/platform/rbac/engine";

/** Only ACTIVE people in ACTIVE memberships are on the roster. A REMOVED
 *  membership is a seat someone has left; an OFFBOARDED person has left the
 *  clinic. Both are excluded from every count and list in this module. */
const ON_ROSTER = { status: "ACTIVE" as const, person: { status: "ACTIVE" as const } };

/**
 * Which departments the VIEWER may see at all, as opposed to which ones they
 * asked for. `null` is the clinic; a list is the departments a scoped grant
 * reaches. An empty list selects nobody, deliberately: a scoped viewer whose
 * grant resolves to no department must see an empty directory, never the whole
 * clinic, so a bug upstream fails closed.
 */
export type DirectoryScope = { departmentIds: string[] } | null;

/**
 * The viewer's scope, resolved from their grants. The one resolver both the
 * page and the export route call, so what downloads is never wider than what
 * was on screen.
 *
 * Clinic-wide wins when the viewer holds both: `volunteers.view_directory` is
 * an unscoped grant, and can() is the right question for it precisely because
 * it is department-blind. The scoped half must go through
 * permissionDepartmentIds instead, which keeps each assignment's own target --
 * for the kind-targeted Director role that is the departments the person
 * DIRECTS, not every department they belong to.
 */
export async function directoryScopeFor(personId: string): Promise<DirectoryScope> {
  if (await can(personId, "volunteers.view_directory")) return null;
  return {
    departmentIds: await permissionDepartmentIds(
      personId,
      "volunteers.view_directory_own_dept",
    ),
  };
}

/** Seat-level department filter for `scope`, spread into a Prisma where. */
function scopeWhere(scope: DirectoryScope) {
  return scope ? { departmentId: { in: scope.departmentIds } } : {};
}

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

export type DirectorySeat = { departmentCode: string; kind: "DIRECTOR" | "VOLUNTEER" };

export type DirectoryPerson = {
  id: string;
  name: string;
  netId: string | null;
  contactEmail: string | null;
  phone: string | null;
  /** The seats that MATCHED the filters, department code ascending. With no
   *  department or role filter that is every seat this person holds. */
  seats: DirectorySeat[];
  /** The rest of this person's seats this term -- the ones the filters did not
   *  select. Filtering to Nursing must not make a Nursing director who also
   *  volunteers in Triage look like a one-department person, so the other seats
   *  come back too, for the page to show as context rather than as matches. */
  otherSeats: DirectorySeat[];
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
export async function directorySummary(
  termId: string | null,
  scope: DirectoryScope,
): Promise<DirectorySummary> {
  // Attendings are not term-scoped: the roster predates Hub terms and a doctor
  // covers clinic whether or not a term is active, so this count stands even
  // when there is no active term at all.
  //
  // They belong to no department either, which is why a scoped viewer gets zero
  // rather than a number they have no departmental claim on. The page drops the
  // tile and the section entirely for them; this keeps the service honest if it
  // ever forgets to.
  const attendings = scope ? 0 : await prisma.attending.count({ where: { isActive: true } });
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

  const seatWhere = { termId, ...ON_ROSTER, ...scopeWhere(scope) };
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
 * exactly the thing worth noticing. A scoped viewer gets the same treatment for
 * their own departments, and no row at all for anyone else's.
 */
export async function departmentBreakdown(
  termId: string | null,
  scope: DirectoryScope,
): Promise<DepartmentBreakdownRow[]> {
  const departments = await prisma.department.findMany({
    where: scope ? { id: { in: scope.departmentIds } } : {},
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
    where: { termId, ...ON_ROSTER, ...scopeWhere(scope) },
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

/**
 * A seat's department predicate: the department the viewer ASKED for,
 * intersected with the departments they may see at all.
 *
 * Intersected rather than spread into one object literal, because both halves
 * write the key `departmentId` and the later one would silently win. Written
 * the other way round, a scoped director hand-editing `?departmentId=` to name
 * a department outside their scope would have WIDENED the query instead of
 * narrowing it. An out-of-scope request selects nobody, which is the honest
 * answer and fails closed.
 */
function departmentSeatFilter(requested: string | undefined, scope: DirectoryScope) {
  const allowed = scope?.departmentIds;
  if (requested) {
    if (allowed && !allowed.includes(requested)) return { departmentId: { in: [] as string[] } };
    return { departmentId: requested };
  }
  return allowed ? { departmentId: { in: allowed } } : {};
}

/** The Prisma filter shared by the paged list and the unpaged export, so the two
 *  can never select different people for the same filters on screen. */
function peopleWhere(termId: string, filters: DirectoryFilters, scope: DirectoryScope) {
  const seat = {
    termId,
    ...ON_ROSTER,
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...departmentSeatFilter(filters.departmentId, scope),
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
 * The seat selector: EVERY on-roster seat this person holds this term, whatever
 * the filters say.
 *
 * The outer `where` decides which PEOPLE come back; this nested read decides how
 * much of each person is visible, and those are different questions. Mirroring
 * the department filter here once looked tidier -- a Nursing filter listing
 * someone's Triage seat reads like a leak -- but it hid the fact worth seeing:
 * under a department filter every row showed exactly one department, so the
 * people serving in two became indistinguishable from the people serving in one.
 *
 * So seats come back whole and `toDirectoryPerson` splits them into the ones
 * that matched and the ones that did not, leaving the page (and the CSV) to
 * decide how to draw the difference.
 *
 * "Whole" means whole WITHIN SCOPE. The viewer's scope is not a filter they
 * chose, it is the boundary of what they may see, so a department outside it is
 * not rendered as context either -- for a scoped director "also" reads "also in
 * your other departments".
 */
function seatSelect(termId: string, scope: DirectoryScope) {
  return {
    where: { termId, ...ON_ROSTER, ...scopeWhere(scope) },
    select: { kind: true, departmentId: true, department: { select: { code: true } } },
    orderBy: [{ department: { code: "asc" as const } }],
  };
}

function toDirectoryPerson(
  row: {
    id: string;
    name: string;
    netId: string | null;
    contactEmail: string | null;
    phone: string | null;
    memberships: { kind: string; departmentId: string; department: { code: string } }[];
  },
  filters: DirectoryFilters,
): DirectoryPerson {
  // Exactly the predicate `seatSelect` used to push into SQL, applied in memory
  // now that both halves are wanted. Keep the two in step: a seat matches iff it
  // is one of the seats that could have put this person in the result set.
  const isMatch = (m: { kind: string; departmentId: string }) =>
    (!filters.departmentId || m.departmentId === filters.departmentId) &&
    (!filters.kind || m.kind === filters.kind);

  const toSeat = (m: { kind: string; department: { code: string } }): DirectorySeat => ({
    departmentCode: m.department.code,
    kind: m.kind as "DIRECTOR" | "VOLUNTEER",
  });

  return {
    id: row.id,
    name: row.name,
    netId: row.netId,
    contactEmail: row.contactEmail,
    phone: row.phone,
    seats: row.memberships.filter(isMatch).map(toSeat),
    otherSeats: row.memberships.filter((m) => !isMatch(m)).map(toSeat),
  };
}

/** One page of the filtered roster, ordered by name. */
export async function directoryPeople(
  termId: string | null,
  filters: DirectoryFilters,
  scope: DirectoryScope,
  page: number,
  pageSize: number,
): Promise<{ rows: DirectoryPerson[]; total: number; page: number; pageCount: number }> {
  if (!termId) return { rows: [], total: 0, page: 1, pageCount: 1 };
  const where = peopleWhere(termId, filters, scope);
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
        memberships: seatSelect(termId, scope),
      },
      orderBy: { name: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return {
    rows: rows.map((r) => toDirectoryPerson(r, filters)),
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
  scope: DirectoryScope,
): Promise<DirectoryPerson[]> {
  if (!termId) return [];
  const rows = await prisma.person.findMany({
    where: peopleWhere(termId, filters, scope),
    select: {
      id: true,
      name: true,
      netId: true,
      contactEmail: true,
      phone: true,
      memberships: seatSelect(termId, scope),
    },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => toDirectoryPerson(r, filters));
}

/**
 * Every address the current filters select, deduped, ordered by the person's
 * name. Feeds the copy-to-clipboard list next to the CSV export.
 *
 * "Every", not "this page": the whole point is one paste for a whole department,
 * and a list that silently stopped at fifty would be worse than no list. The
 * clinic is a few hundred people, so this is a short query returning two small
 * columns, not the roster.
 *
 * Deduped because a mailing list must not carry the same address twice for
 * someone who sits in two departments -- the same rule the CSV's one-row-per-
 * person shape enforces. People with neither a NetID nor a contact address
 * resolve to "" and are dropped rather than pasted into a To: field as a blank.
 */
export async function directoryEmails(
  termId: string | null,
  filters: DirectoryFilters,
  scope: DirectoryScope,
): Promise<string[]> {
  if (!termId) return [];
  const rows = await prisma.person.findMany({
    where: peopleWhere(termId, filters, scope),
    select: { netId: true, contactEmail: true },
    orderBy: { name: "asc" },
  });
  return [...new Set(rows.map(accountEmailForPerson).filter((email) => email !== ""))];
}

/**
 * Active attendings, ordered by name. Faculty hold no membership and belong to
 * no department, so they are never filtered by either -- and for the same
 * reason a department-scoped viewer has no departmental claim on them and gets
 * an empty list rather than the faculty contact sheet.
 */
export async function directoryAttendings(scope: DirectoryScope): Promise<DirectoryAttending[]> {
  if (scope) return [];
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
