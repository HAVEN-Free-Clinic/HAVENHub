/**
 * Builder service for HAVEN Hub's schedule builder page.
 *
 * Scope is enforced internally per mutation: every write checks that the
 * actor's manageable department set includes the target department before
 * touching any data. builderView trusts the caller for page-level gating
 * but scopes its data to the viewer's manageable departments.
 *
 * Typed errors: BuilderForbiddenError, BuilderValidationError.
 */

import type { RhdClinic } from "@prisma/client";
import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { isoDateKey } from "@/platform/dates";
import { manageableDepartmentIds } from "@/platform/departments";
import { can } from "@/platform/rbac/engine";
import { complianceStatus } from "@/platform/compliance/rules";
import { resolveAvailability } from "../engine/availability";
import type { ResolvedAvailability } from "../engine/availability";
import { toScheduleEntries } from "../engine/map";
import { computeConflicts } from "../engine/conflicts";
import { computeDayMetrics, rolesForDept } from "../engine/capacity";
import type { DayMetrics } from "../engine/capacity";
import { summarizeNonCompliant } from "../engine/banner";
import type { DeptBanner } from "../engine/banner";
import { computeClinicReadiness } from "../engine/rhd";
import type { ClinicReadiness, RhdPersonLite, Attending } from "../engine/rhd";
import { config } from "@/platform/config";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Actor lacks permission to manage the target department. */
export class BuilderForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "BuilderForbiddenError";
  }
}

/** Input is invalid or violates schedule invariants. */
export class BuilderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuilderValidationError";
  }
}

// ---------------------------------------------------------------------------
// RHD department codes
// ---------------------------------------------------------------------------

const RHD_CODES = new Set(["SCTS", "JCTS", "CCRH"]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the active term or null. */
async function getActiveTerm() {
  return prisma.term.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { startDate: "desc" },
  });
}

/**
 * Validates that the actor may manage the given departmentId.
 * Throws BuilderForbiddenError when not.
 */
async function scopeCheck(actorPersonId: string, departmentId: string): Promise<void> {
  const manageable = await manageableScheduleDepartmentIds(actorPersonId);
  if (!manageable.includes(departmentId)) {
    throw new BuilderForbiddenError();
  }
}

// ---------------------------------------------------------------------------
// Scoping helper (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Returns the set of department ids the person may manage for schedule
 * purposes: manageableDepartmentIds(personId) UNION (when
 * can(personId, "schedule.edit_all")) ALL department ids. Deduped.
 */
export async function manageableScheduleDepartmentIds(personId: string): Promise<string[]> {
  const [base, editAll] = await Promise.all([
    manageableDepartmentIds(personId),
    can(personId, "schedule.edit_all"),
  ]);

  if (!editAll) return base;

  // edit_all: union base with every department in the DB.
  const all = await prisma.department.findMany({ select: { id: true } });
  const ids = new Set<string>(base);
  for (const d of all) ids.add(d.id);
  return [...ids];
}

// ---------------------------------------------------------------------------
// setAssignment
// ---------------------------------------------------------------------------

/**
 * Assigns or unassigns a person to a clinic date in a department.
 *
 * role "VOLUNTEER" | "SHADOW" | "DIRECTOR": upsert on the unique key.
 *   - Create: all tags false.
 *   - Update: role only (existing tags preserved).
 * role null: delete the row (tags die with it). Reason captured in audit.
 *
 * Validation:
 *   - dateKey must be a clinic date in the active term.
 *   - person must have an ACTIVE membership in the department+term.
 *   - role DIRECTOR only allowed when membership.kind === "DIRECTOR".
 */
export async function setAssignment(
  actor: string,
  opts: {
    departmentId: string;
    dateKey: string;
    personId: string;
    role: "VOLUNTEER" | "SHADOW" | "DIRECTOR" | null;
    reason?: string;
  }
): Promise<void> {
  await scopeCheck(actor, opts.departmentId);

  const term = await getActiveTerm();
  if (!term) throw new BuilderValidationError("No active term.");

  // Validate clinic date.
  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === opts.dateKey);
  if (!clinicDate) {
    throw new BuilderValidationError(`${opts.dateKey} is not a clinic date in the active term.`);
  }

  if (opts.role !== null) {
    // Validate membership.
    const membership = await prisma.termMembership.findFirst({
      where: {
        termId: term.id,
        departmentId: opts.departmentId,
        personId: opts.personId,
        status: "ACTIVE",
      },
    });
    if (!membership) {
      throw new BuilderValidationError(
        "Person does not have an active membership in this department for the current term."
      );
    }

    // Director role requires director-kind membership.
    if (opts.role === "DIRECTOR" && membership.kind !== "DIRECTOR") {
      throw new BuilderValidationError(
        "DIRECTOR role may only be assigned to members with a DIRECTOR membership kind."
      );
    }

    await prisma.shiftAssignment.upsert({
      where: {
        termId_departmentId_clinicDate_personId: {
          termId: term.id,
          departmentId: opts.departmentId,
          clinicDate,
          personId: opts.personId,
        },
      },
      create: {
        termId: term.id,
        departmentId: opts.departmentId,
        clinicDate,
        personId: opts.personId,
        role: opts.role,
        triage: false,
        walkin: false,
        cc: false,
        remote: false,
      },
      update: { role: opts.role },
    });

    await recordAudit({
      actorPersonId: actor,
      action: "schedule.assign",
      entityType: "ShiftAssignment",
      entityId: `${term.id}|${opts.departmentId}|${opts.dateKey}|${opts.personId}`,
      after: { role: opts.role, dateKey: opts.dateKey, personId: opts.personId },
    });
  } else {
    // Unassign: capture before state then delete.
    const existing = await prisma.shiftAssignment.findFirst({
      where: {
        termId: term.id,
        departmentId: opts.departmentId,
        clinicDate,
        personId: opts.personId,
      },
    });

    await prisma.shiftAssignment.deleteMany({
      where: {
        termId: term.id,
        departmentId: opts.departmentId,
        clinicDate,
        personId: opts.personId,
      },
    });

    await recordAudit({
      actorPersonId: actor,
      action: "schedule.unassign",
      entityType: "ShiftAssignment",
      entityId: `${term.id}|${opts.departmentId}|${opts.dateKey}|${opts.personId}`,
      before: {
        role: existing?.role ?? null,
        dateKey: opts.dateKey,
        personId: opts.personId,
        reason: opts.reason ?? null,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// toggleTag
// ---------------------------------------------------------------------------

/**
 * Flips a boolean tag (triage, walkin, cc, remote) on an existing assignment.
 *
 * Throws BuilderValidationError when no assignment row exists for the
 * person/date/department combination.
 */
export async function toggleTag(
  actor: string,
  opts: {
    departmentId: string;
    dateKey: string;
    personId: string;
    tag: "triage" | "walkin" | "cc" | "remote";
  }
): Promise<void> {
  await scopeCheck(actor, opts.departmentId);

  const term = await getActiveTerm();
  if (!term) throw new BuilderValidationError("No active term.");

  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === opts.dateKey);
  if (!clinicDate) {
    throw new BuilderValidationError(`${opts.dateKey} is not a clinic date in the active term.`);
  }

  const existing = await prisma.shiftAssignment.findFirst({
    where: {
      termId: term.id,
      departmentId: opts.departmentId,
      clinicDate,
      personId: opts.personId,
    },
  });
  if (!existing) {
    throw new BuilderValidationError("No assignment row found for this person/date/department.");
  }

  const newValue = !existing[opts.tag];
  await prisma.shiftAssignment.update({
    where: { id: existing.id },
    data: { [opts.tag]: newValue },
  });

  await recordAudit({
    actorPersonId: actor,
    action: "schedule.tag",
    entityType: "ShiftAssignment",
    entityId: existing.id,
    before: { [opts.tag]: existing[opts.tag] },
    after: { [opts.tag]: newValue },
  });
}

// ---------------------------------------------------------------------------
// setPatientsBooked
// ---------------------------------------------------------------------------

/**
 * Upserts the patientsBooked field on the ScheduleDay row for a
 * (term, department, date) triple. A null value clears the field.
 */
export async function setPatientsBooked(
  actor: string,
  opts: { departmentId: string; dateKey: string; patientsBooked: number | null }
): Promise<void> {
  await scopeCheck(actor, opts.departmentId);

  const term = await getActiveTerm();
  if (!term) throw new BuilderValidationError("No active term.");

  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === opts.dateKey);
  if (!clinicDate) {
    throw new BuilderValidationError(`${opts.dateKey} is not a clinic date in the active term.`);
  }

  await prisma.scheduleDay.upsert({
    where: {
      termId_departmentId_clinicDate: {
        termId: term.id,
        departmentId: opts.departmentId,
        clinicDate,
      },
    },
    create: {
      termId: term.id,
      departmentId: opts.departmentId,
      clinicDate,
      patientsBooked: opts.patientsBooked,
    },
    update: { patientsBooked: opts.patientsBooked },
  });

  await recordAudit({
    actorPersonId: actor,
    action: "schedule.patients_booked",
    entityType: "ScheduleDay",
    entityId: `${term.id}|${opts.departmentId}|${opts.dateKey}`,
    after: { patientsBooked: opts.patientsBooked },
  });
}

// ---------------------------------------------------------------------------
// setAvailabilityOverride
// ---------------------------------------------------------------------------

/**
 * Sets or clears the director availability override for a membership.
 *
 * dateKeys non-null: validates each is a clinic date, stores canonical
 * clinic Date objects as directorAvailabilityDates and sets
 * directorAvailabilitySetAt = now.
 * dateKeys null: clears (directorAvailabilityDates = [],
 * directorAvailabilitySetAt = null).
 *
 * The membership must be in a department the actor manages.
 */
export async function setAvailabilityOverride(
  actor: string,
  opts: { membershipId: string; dateKeys: string[] | null }
): Promise<void> {
  const membership = await prisma.termMembership.findUnique({
    where: { id: opts.membershipId },
    include: { term: true },
  });
  if (!membership) throw new BuilderValidationError("Membership not found.");

  await scopeCheck(actor, membership.departmentId);

  if (opts.dateKeys !== null) {
    const canonicalByKey = new Map<string, Date>();
    for (const d of membership.term.clinicDates) {
      canonicalByKey.set(isoDateKey(d), d);
    }

    const badKeys = opts.dateKeys.filter((k) => !canonicalByKey.has(k));
    if (badKeys.length > 0) {
      throw new BuilderValidationError(
        `The following dates are not clinic dates: ${badKeys.join(", ")}`
      );
    }

    const canonicalDates = opts.dateKeys
      .map((k) => canonicalByKey.get(k)!)
      .sort((a, b) => (isoDateKey(a) < isoDateKey(b) ? -1 : 1));

    await prisma.termMembership.update({
      where: { id: opts.membershipId },
      data: {
        directorAvailabilityDates: canonicalDates,
        directorAvailabilitySetAt: new Date(),
      },
    });
  } else {
    await prisma.termMembership.update({
      where: { id: opts.membershipId },
      data: {
        directorAvailabilityDates: [],
        directorAvailabilitySetAt: null,
      },
    });
  }

  await recordAudit({
    actorPersonId: actor,
    action: "schedule.availability_override",
    entityType: "TermMembership",
    entityId: opts.membershipId,
    after: { dateKeys: opts.dateKeys },
  });
}

// ---------------------------------------------------------------------------
// acknowledgeAvailability
// ---------------------------------------------------------------------------

/**
 * Stamps availabilityAcknowledgedAt = now on the membership.
 * The membership must be in a department the actor manages.
 */
export async function acknowledgeAvailability(
  actor: string,
  membershipId: string
): Promise<void> {
  const membership = await prisma.termMembership.findUnique({
    where: { id: membershipId },
  });
  if (!membership) throw new BuilderValidationError("Membership not found.");

  await scopeCheck(actor, membership.departmentId);

  await prisma.termMembership.update({
    where: { id: membershipId },
    data: { availabilityAcknowledgedAt: new Date() },
  });

  await recordAudit({
    actorPersonId: actor,
    action: "schedule.availability_acknowledge",
    entityType: "TermMembership",
    entityId: membershipId,
  });
}

// ---------------------------------------------------------------------------
// upsertRhdClinic
// ---------------------------------------------------------------------------

/**
 * Upserts the RhdClinic row for a term+date.
 *
 * Actor must manage at least one RHD-family department (SCTS, JCTS, CCRH).
 * The dateKey must be a clinic date in the active term.
 */
export async function upsertRhdClinic(
  actor: string,
  opts: {
    dateKey: string;
    attendingId?: string | null;
    directorName?: string | null;
    proceduresBooked?: number | null;
  }
): Promise<void> {
  // Scope: must manage at least one RHD department.
  const manageable = await manageableScheduleDepartmentIds(actor);
  const rhdDepts = await prisma.department.findMany({
    where: { code: { in: [...RHD_CODES] } },
    select: { id: true },
  });
  const rhdIds = new Set(rhdDepts.map((d) => d.id));
  const hasRhd = manageable.some((id) => rhdIds.has(id));
  if (!hasRhd) throw new BuilderForbiddenError("Actor does not manage any RHD-family department.");

  const term = await getActiveTerm();
  if (!term) throw new BuilderValidationError("No active term.");

  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === opts.dateKey);
  if (!clinicDate) {
    throw new BuilderValidationError(`${opts.dateKey} is not a clinic date in the active term.`);
  }

  await prisma.rhdClinic.upsert({
    where: { termId_clinicDate: { termId: term.id, clinicDate } },
    create: {
      termId: term.id,
      clinicDate,
      attendingId: opts.attendingId ?? null,
      directorName: opts.directorName ?? null,
      proceduresBooked: opts.proceduresBooked ?? null,
    },
    update: {
      ...("attendingId" in opts && { attendingId: opts.attendingId ?? null }),
      ...("directorName" in opts && { directorName: opts.directorName ?? null }),
      ...("proceduresBooked" in opts && { proceduresBooked: opts.proceduresBooked ?? null }),
    },
  });

  await recordAudit({
    actorPersonId: actor,
    action: "schedule.rhd_clinic",
    entityType: "RhdClinic",
    entityId: `${term.id}|${opts.dateKey}`,
    after: opts,
  });
}

// ---------------------------------------------------------------------------
// builderView types
// ---------------------------------------------------------------------------

export type BuilderMember = {
  membershipId: string;
  person: { id: string; name: string; spanishSpeaking: boolean; licensedRN: boolean };
  kind: "DIRECTOR" | "VOLUNTEER";
  availability: ResolvedAvailability;
  overrideActive: boolean;
  acknowledgePending: boolean;
  legacyNote: string | null;
};

export type BuilderAssignmentEntry = {
  role: "VOLUNTEER" | "SHADOW" | "DIRECTOR";
  tags: { triage: boolean; walkin: boolean; cc: boolean; remote: boolean };
};

export type BuilderRhd = {
  readiness: ClinicReadiness;
  attendingOptions: { id: string; scheduleName: string }[];
  clinic: RhdClinic | null;
};

export type BuilderView = {
  departments: { id: string; code: string; name: string }[];
  selectedDepartment: { id: string; code: string; name: string } | null;
  clinicDates: Date[];
  selectedDate: Date | null;
  selectedDateKey: string | null;
  members: BuilderMember[];
  /** Nested map: dateKey -> personId -> assignment entry. */
  assignmentsByDate: Record<string, Record<string, BuilderAssignmentEntry>>;
  capacity: DayMetrics;
  banner: DeptBanner[];
  /** Map: personId -> array of other-department names with same-day conflict. */
  conflicts: Record<string, string[]>;
  pendingRequestCount: number;
  rhd: BuilderRhd | null;
};

// ---------------------------------------------------------------------------
// builderView
// ---------------------------------------------------------------------------

/**
 * The primary read for the schedule builder page.
 *
 * Returns the viewer's selectable departments, the selected department and date,
 * all members with resolved availability, all term assignments (for the grid),
 * capacity metrics, compliance banner, conflicts, pending request count, and
 * (for RHD departments) the RHD clinic block.
 */
export async function builderView(
  viewerPersonId: string,
  opts: { departmentId?: string; dateKey?: string; now?: Date }
): Promise<BuilderView> {
  const now = opts.now ?? new Date();

  const manageableIds = await manageableScheduleDepartmentIds(viewerPersonId);

  // Empty state when viewer manages nothing.
  const emptyMetrics = computeDayMetrics(
    { onShift: 0, triage: 0, walkin: 0, shadow: 0, spanish: 0, patientsBooked: null },
    { idealHeadcount: null, patientCapacityPerProvider: null }
  );

  if (manageableIds.length === 0) {
    return {
      departments: [],
      selectedDepartment: null,
      clinicDates: [],
      selectedDate: null,
      selectedDateKey: null,
      members: [],
      assignmentsByDate: {},
      capacity: emptyMetrics,
      banner: [],
      conflicts: {},
      pendingRequestCount: 0,
      rhd: null,
    };
  }

  // Load departments in code order.
  const departments = await prisma.department.findMany({
    where: { id: { in: manageableIds } },
    orderBy: { code: "asc" },
  });

  // Resolve selected department.
  let selectedDept =
    opts.departmentId
      ? departments.find((d) => d.id === opts.departmentId) ?? departments[0]
      : departments[0];

  const deptLites = departments.map((d) => ({ id: d.id, code: d.code, name: d.name }));

  // Load active term.
  const term = await getActiveTerm();
  if (!term) {
    return {
      departments: deptLites,
      selectedDepartment: { id: selectedDept.id, code: selectedDept.code, name: selectedDept.name },
      clinicDates: [],
      selectedDate: null,
      selectedDateKey: null,
      members: [],
      assignmentsByDate: {},
      capacity: emptyMetrics,
      banner: [],
      conflicts: {},
      pendingRequestCount: 0,
      rhd: null,
    };
  }

  const { clinicDates } = term;

  // Resolve selected date.
  let selectedDate: Date | null = null;
  if (opts.dateKey) {
    selectedDate = clinicDates.find((d) => isoDateKey(d) === opts.dateKey) ?? null;
  }
  if (!selectedDate) {
    const nowKey = isoDateKey(now);
    selectedDate = clinicDates.find((d) => isoDateKey(d) >= nowKey) ?? (clinicDates[clinicDates.length - 1] ?? null);
  }
  const selectedDateKey = selectedDate ? isoDateKey(selectedDate) : null;

  // Load all assignments for the term in the selected department.
  const [allAssignments, members, scheduleDay, pendingCount] = await Promise.all([
    prisma.shiftAssignment.findMany({
      where: { termId: term.id, departmentId: selectedDept.id },
      include: {
        person: { select: { id: true, name: true, spanishSpeaking: true, licensedRN: true } },
      },
    }),
    prisma.termMembership.findMany({
      where: { termId: term.id, departmentId: selectedDept.id, status: "ACTIVE" },
      include: {
        person: {
          include: { hipaaCertificates: { orderBy: { uploadedAt: "desc" }, take: 1 } },
        },
      },
      orderBy: { person: { name: "asc" } },
    }),
    selectedDate
      ? prisma.scheduleDay.findFirst({
          where: { termId: term.id, departmentId: selectedDept.id, clinicDate: selectedDate },
        })
      : Promise.resolve(null),
    prisma.shiftRequest.count({
      where: { termId: term.id, departmentId: selectedDept.id, status: "PENDING" },
    }),
  ]);

  // Build assignmentsByDate.
  const assignmentsByDate: Record<string, Record<string, BuilderAssignmentEntry>> = {};
  for (const a of allAssignments) {
    const dk = isoDateKey(a.clinicDate);
    if (!assignmentsByDate[dk]) assignmentsByDate[dk] = {};
    assignmentsByDate[dk][a.personId] = {
      role: a.role as "VOLUNTEER" | "SHADOW" | "DIRECTOR",
      tags: { triage: a.triage, walkin: a.walkin, cc: a.cc, remote: a.remote },
    };
  }

  // Build members list.
  const builderMembers: BuilderMember[] = members.map((m) => {
    const availability = resolveAvailability({
      baseline: m.baselineAvailability,
      selfDates: m.selfAvailabilityDates,
      selfUpdatedAt: m.availabilityUpdatedAt,
      directorDates: m.directorAvailabilityDates,
      directorSetAt: m.directorAvailabilitySetAt,
    });

    return {
      membershipId: m.id,
      person: {
        id: m.person.id,
        name: m.person.name,
        spanishSpeaking: m.person.spanishSpeaking,
        licensedRN: m.person.licensedRN,
      },
      kind: m.kind as "DIRECTOR" | "VOLUNTEER",
      availability,
      overrideActive: m.directorAvailabilitySetAt !== null,
      acknowledgePending:
        m.availabilityUpdatedAt !== null && m.availabilityAcknowledgedAt === null,
      legacyNote: m.selfUpdatedAvailability ?? null,
    };
  });

  // Capacity for the selected date.
  const selectedAssignments = selectedDateKey ? allAssignments.filter((a) => isoDateKey(a.clinicDate) === selectedDateKey) : [];

  // Build a set of person details for spanish/RN counts.
  const personById = new Map(members.map((m) => [m.person.id, m.person]));

  const onShiftPeople = selectedAssignments.filter((a) => a.role === "VOLUNTEER" || a.role === "DIRECTOR");
  const spanishCount = onShiftPeople.filter((a) => {
    const p = personById.get(a.personId) ?? a.person;
    return p.spanishSpeaking;
  }).length;

  const capacity = computeDayMetrics(
    {
      onShift: onShiftPeople.length,
      triage: selectedAssignments.filter((a) => a.triage).length,
      walkin: selectedAssignments.filter((a) => a.walkin).length,
      shadow: selectedAssignments.filter((a) => a.role === "SHADOW").length,
      spanish: spanishCount,
      patientsBooked: scheduleDay?.patientsBooked ?? null,
    },
    {
      idealHeadcount: selectedDept.idealHeadcount ?? null,
      patientCapacityPerProvider: selectedDept.patientCapacityPerProvider ?? null,
    }
  );

  // Banner: compliance status for VOLUNTEER assignees on selected date.
  const volunteerAssigneesOnDate = selectedAssignments.filter((a) => a.role === "VOLUNTEER");

  const bannerVolunteers = volunteerAssigneesOnDate.map((a) => {
    // Find the member's newest cert from the members list.
    const memberEntry = members.find((m) => m.person.id === a.personId);
    const certs = memberEntry?.person.hipaaCertificates ?? [];
    const newestCert = certs.length > 0 ? certs[0] : null;
    const status = complianceStatus(
      newestCert ? { completionDate: newestCert.completionDate } : null,
      term.endDate,
      now
    );
    const person = memberEntry?.person ?? a.person;
    return { id: person.id, name: person.name, status };
  });

  const banner = summarizeNonCompliant([
    {
      departmentId: selectedDept.id,
      departmentName: selectedDept.name,
      volunteers: bannerVolunteers,
    },
  ]);

  // Conflicts: load ALL term assignments across ALL departments for conflict computation.
  const allTermAssignments = await prisma.shiftAssignment.findMany({
    where: { termId: term.id },
    select: {
      personId: true,
      departmentId: true,
      clinicDate: true,
      role: true,
      department: { select: { name: true } },
    },
  });

  const engineRows = allTermAssignments.map((a) => ({
    departmentId: a.departmentId,
    departmentName: a.department.name,
    personId: a.personId,
    clinicDate: a.clinicDate,
    role: a.role as "DIRECTOR" | "VOLUNTEER" | "SHADOW",
  }));
  const allEntries = toScheduleEntries(engineRows);

  const conflicts: Record<string, string[]> = {};
  if (selectedDateKey) {
    for (const a of selectedAssignments) {
      const result = computeConflicts({
        personId: a.personId,
        thisDepartmentId: selectedDept.id,
        allSchedule: allEntries,
      });
      const otherDeptNames = result.sameDay
        .filter((c) => c.date === selectedDateKey)
        .map((c) => c.otherDept);
      if (otherDeptNames.length > 0) {
        conflicts[a.personId] = otherDeptNames;
      }
    }
  }

  // RHD block.
  let rhd: BuilderRhd | null = null;
  if (RHD_CODES.has(selectedDept.code)) {
    rhd = await buildRhdBlock(term, selectedDept.code, selectedDateKey, allTermAssignments);
  }

  return {
    departments: deptLites,
    selectedDepartment: { id: selectedDept.id, code: selectedDept.code, name: selectedDept.name },
    clinicDates,
    selectedDate,
    selectedDateKey,
    members: builderMembers,
    assignmentsByDate,
    capacity,
    banner,
    conflicts,
    pendingRequestCount: pendingCount,
    rhd,
  };
}

// ---------------------------------------------------------------------------
// RHD block builder (private)
// ---------------------------------------------------------------------------

type MinimalAssignment = {
  personId: string;
  departmentId: string;
  clinicDate: Date;
  role: string;
  department: { name: string };
};

/**
 * Builds the RHD block for the builderView.
 * Loads RhdClinic, attending, attending options, and computes readiness.
 */
async function buildRhdBlock(
  term: { id: string; clinicDates: Date[] },
  deptCode: string,
  selectedDateKey: string | null,
  allTermAssignments: MinimalAssignment[]
): Promise<BuilderRhd | null> {
  if (!selectedDateKey) return null;

  // Load attending options (active attendings for the dropdown).
  const attendingOptions = await prisma.rhdAttending.findMany({
    where: { isActive: true },
    select: { id: true, scheduleName: true },
    orderBy: { scheduleName: "asc" },
  });

  // Load the clinic row for the selected date.
  const clinicDate = term.clinicDates.find((d) => isoDateKey(d) === selectedDateKey);
  if (!clinicDate) return null;

  const clinic = await prisma.rhdClinic.findFirst({
    where: { termId: term.id, clinicDate },
  });

  // Load the attending if assigned.
  let attending: Attending | null = null;
  if (clinic?.attendingId) {
    const att = await prisma.rhdAttending.findUnique({ where: { id: clinic.attendingId } });
    if (att) {
      attending = {
        id: att.id,
        scheduleName: att.scheduleName,
        fullName: att.fullName,
        procedures: {
          iudIn: att.iudIn as "yes" | "no" | "unknown",
          iudOut: att.iudOut as "yes" | "no" | "unknown",
          nexplanon: att.nexplanon as "yes" | "no" | "unknown",
          gac: att.gac as "yes" | "no" | "unknown",
          emb: att.emb as "yes" | "no" | "unknown",
          seesMale: att.seesMale as "yes" | "no" | "unknown",
        },
        notes: att.notes ?? undefined,
      };
    }
  }

  // Resolve RHD department ids.
  const rhdDepts = await prisma.department.findMany({
    where: { code: { in: ["SCTS", "JCTS", "CCRH"] } },
    select: { id: true, code: true },
  });
  const deptIdToCode = new Map(rhdDepts.map((d) => [d.id, d.code]));

  // Build RhdPersonLite lists for each RHD department on the selected date.
  // Need person flags; load persons for the relevant assignments.
  const selectedRhdAssignments = allTermAssignments.filter(
    (a) =>
      isoDateKey(a.clinicDate) === selectedDateKey &&
      deptIdToCode.has(a.departmentId) &&
      (a.role === "VOLUNTEER" || a.role === "DIRECTOR")
  );

  const personIds = [...new Set(selectedRhdAssignments.map((a) => a.personId))];
  const persons = personIds.length > 0
    ? await prisma.person.findMany({
        where: { id: { in: personIds } },
        select: { id: true, contactEmail: true, licensedRN: true, spanishSpeaking: true },
      })
    : [];
  const personMap = new Map(persons.map((p) => [p.id, p]));

  function toRhdPerson(personId: string): RhdPersonLite {
    const p = personMap.get(personId);
    return {
      id: personId,
      email: p?.contactEmail ?? "",
      licensedRN: p?.licensedRN ?? false,
      spanishSpeaking: p?.spanishSpeaking ?? false,
    };
  }

  const sctsId = rhdDepts.find((d) => d.code === "SCTS")?.id;
  const jctsId = rhdDepts.find((d) => d.code === "JCTS")?.id;
  const ccrhId = rhdDepts.find((d) => d.code === "CCRH")?.id;

  const sctsOnShift = selectedRhdAssignments
    .filter((a) => a.departmentId === sctsId)
    .map((a) => toRhdPerson(a.personId));
  const jctsOnShift = selectedRhdAssignments
    .filter((a) => a.departmentId === jctsId)
    .map((a) => toRhdPerson(a.personId));
  const ccrhOnShift = selectedRhdAssignments
    .filter((a) => a.departmentId === ccrhId)
    .map((a) => toRhdPerson(a.personId));

  const readiness = computeClinicReadiness({
    date: selectedDateKey,
    attending,
    director: clinic?.directorName ?? null,
    sctsOnShift,
    jctsOnShift,
    ccrhOnShift,
    proceduresBooked: clinic?.proceduresBooked ?? null,
    maxProceduresPerClinic: config.RHD_MAX_PROCEDURES,
  });

  return { readiness, attendingOptions, clinic: clinic ?? null };
}
