/**
 * Auto-assign: propose a term's volunteer schedule for one department, then
 * apply the proposal a director has approved.
 *
 * The decisions live in engine/auto-assign.ts, which is pure. This file is the
 * part only a database can answer: who is schedulable, whose availability is in
 * force, who is already committed elsewhere, and how full the board is.
 *
 * ## Applying goes back through setAssignment
 *
 * Every addition is written by {@link setAssignment}, one call per row, rather
 * than by a bulk createMany. That is deliberate: setAssignment is where
 * membership validation, the incoming-draft routing, the archived-term guard,
 * the volunteer cap and the audit trail all live. A second write path beside it
 * would be a second place for those rules to be forgotten, and the first one to
 * drift. A few hundred small writes is the right price for that, on an action a
 * director takes by hand a handful of times a term.
 *
 * Applying is therefore NOT atomic. A row the database refuses (a membership
 * that changed under us, a cap another director just filled) is counted as
 * skipped and the rest still land. That is the honest behaviour for an additive
 * operation: the board is left further along than it was, never inconsistent,
 * and re-running the preview shows exactly what is left.
 */

import { prisma } from "@/platform/db";
import { recordAudit } from "@/platform/audit";
import { isoDateKey } from "@/platform/dates";
import { openClinicDates } from "@/platform/attendings/open-clinic-date";
import { spanishScoresByPerson } from "@/platform/languages";
import {
  listIncomingMembers,
  listIncomingShiftDrafts,
  onboardingNotesByMember,
} from "@/platform/recruitment/incoming-roster";
import { resolveAvailability } from "../engine/availability";
import { autoAssign } from "../engine/auto-assign";
import type {
  AutoAssignAddition,
  AutoAssignMember,
  AutoAssignProposal,
} from "../engine/auto-assign";
import {
  BuilderForbiddenError,
  BuilderValidationError,
  manageableScheduleDepartmentIds,
  provisionalRowId,
  setAssignment,
} from "./builder";

export type AutoAssignPreview = {
  proposal: AutoAssignProposal;
  /** Open clinic dates the proposal covers, in calendar order. */
  dateKeys: string[];
  cap: number | null;
  interpreterBar: number | null;
  /** memberId -> display name, so the preview can name rows without a second load. */
  names: Record<string, string>;
};

/**
 * "1".."7" and "8+" are the only stored answers (SHIFTS_WANTED_OPTIONS).
 * Anything else, including never having answered, is null: an invented number
 * would silently cap somebody who never asked to be capped.
 */
function parseRequestedShifts(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function requireScope(actorPersonId: string, departmentId: string): Promise<void> {
  const manageable = await manageableScheduleDepartmentIds(actorPersonId);
  if (!manageable.includes(departmentId)) {
    throw new BuilderForbiddenError();
  }
}

export async function previewAutoAssign(
  actorPersonId: string,
  opts: { termId: string; departmentId: string },
): Promise<AutoAssignPreview> {
  await requireScope(actorPersonId, opts.departmentId);

  const term = await prisma.term.findUnique({ where: { id: opts.termId } });
  if (!term) throw new BuilderValidationError("Unknown term.");
  const dept = await prisma.department.findUnique({ where: { id: opts.departmentId } });
  if (!dept) throw new BuilderValidationError("Unknown department.");

  // Closed Saturdays are dropped outright rather than shown as gaps: nobody is
  // staffing a clinic that is shut, and a date with zero availability because it
  // is closed would otherwise read as the worst-covered date of the term.
  const openDates = await openClinicDates(term);
  const dateKeys = openDates.map(isoDateKey);
  const openKeys = new Set(dateKeys);

  const [memberships, incomingAll, drafts, boardRows, otherDeptRows] = await Promise.all([
    prisma.termMembership.findMany({
      where: { termId: term.id, departmentId: dept.id, status: "ACTIVE" },
      include: { person: { select: { id: true, name: true } } },
    }),
    listIncomingMembers({ termId: term.id, departmentCode: dept.code, clinicDates: openDates }),
    listIncomingShiftDrafts({ termId: term.id, departmentId: dept.id }),
    prisma.shiftAssignment.findMany({
      where: { termId: term.id, departmentId: dept.id },
      select: { personId: true, clinicDate: true, role: true },
    }),
    // Committed in ANOTHER department this term. A person can only be in one
    // place on a Saturday, so these dates are off the table for them here.
    prisma.shiftAssignment.findMany({
      where: { termId: term.id, departmentId: { not: dept.id } },
      select: { personId: true, clinicDate: true },
    }),
  ]);

  // An incoming member already on the roster is not incoming; mirrors builderView.
  const rosterPersonIds = new Set(memberships.map((m) => m.personId));
  const incoming = incomingAll.filter(
    (i) => i.personId === null || !rosterPersonIds.has(i.personId),
  );

  const personIds = [
    ...new Set([
      ...memberships.map((m) => m.personId),
      ...incoming.map((i) => i.personId).filter((id): id is string => id !== null),
    ]),
  ];
  const [spanish, notes] = await Promise.all([
    spanishScoresByPerson(personIds),
    onboardingNotesByMember({ termId: term.id, departmentCode: dept.code, personIds }),
  ]);

  const conflictsByPerson = new Map<string, string[]>();
  for (const row of otherDeptRows) {
    const key = isoDateKey(row.clinicDate);
    const list = conflictsByPerson.get(row.personId) ?? [];
    list.push(key);
    conflictsByPerson.set(row.personId, list);
  }

  const names: Record<string, string> = {};
  const members: AutoAssignMember[] = [];

  // Directors are not auto-assigned: they are running the day, and which
  // director covers which Saturday is a decision they make between themselves.
  for (const m of memberships) {
    if (m.kind !== "VOLUNTEER") continue;
    const resolved = resolveAvailability({
      baseline: m.baselineAvailability,
      selfDates: m.selfAvailabilityDates,
      selfUpdatedAt: m.availabilityUpdatedAt,
      directorDates: m.directorAvailabilityDates,
      directorSetAt: m.directorAvailabilitySetAt,
    });
    names[m.personId] = m.person.name;
    members.push({
      id: m.personId,
      availableDateKeys: resolved.dates.map(isoDateKey).filter((k) => openKeys.has(k)),
      requestedShifts: parseRequestedShifts(notes.get(m.personId)?.preferredShifts ?? null),
      interpreterScore: spanish.get(m.personId) ?? null,
      conflictDateKeys: conflictsByPerson.get(m.personId) ?? [],
    });
  }

  for (const i of incoming) {
    if (i.kind !== "VOLUNTEER") continue;
    // A first-time applicant has no Person yet, so their row is keyed on the
    // acceptance and they can hold no interpreter score to read.
    const id = i.personId ?? provisionalRowId(i.acceptanceId);
    names[id] = i.name;
    members.push({
      id,
      availableDateKeys: i.availabilityDates.map(isoDateKey).filter((k) => openKeys.has(k)),
      requestedShifts: parseRequestedShifts(i.onboardingNotes.preferredShifts),
      interpreterScore: i.personId ? spanish.get(i.personId) ?? null : null,
      conflictDateKeys: i.personId ? conflictsByPerson.get(i.personId) ?? [] : [],
    });
  }

  // The board as it stands, across BOTH tables it is built from.
  const alreadyAssigned: Record<string, string[]> = {};
  const volunteersOnDate: Record<string, number> = {};
  for (const key of dateKeys) {
    alreadyAssigned[key] = [];
    volunteersOnDate[key] = 0;
  }
  const occupy = (dateKey: string, memberId: string, role: string) => {
    if (!openKeys.has(dateKey)) return;
    alreadyAssigned[dateKey].push(memberId);
    if (role === "VOLUNTEER") volunteersOnDate[dateKey] += 1;
  };
  for (const r of boardRows) occupy(isoDateKey(r.clinicDate), r.personId, r.role);
  for (const d of drafts) {
    occupy(isoDateKey(d.clinicDate), provisionalRowId(d.acceptanceId), d.role);
  }

  const proposal = autoAssign({
    dateKeys,
    members,
    alreadyAssigned,
    volunteersOnDate,
    cap: dept.maxVolunteersPerShift,
    interpreterBar: dept.minInterpreterScore,
    // Someone who never said how many shifts they wanted gets no invented
    // ceiling. Fairness comes from the round-robin, which hands everybody their
    // Nth shift before anybody gets an N+1th.
    fallbackRequestedShifts: dateKeys.length,
  });

  return {
    proposal,
    dateKeys,
    cap: dept.maxVolunteersPerShift,
    interpreterBar: dept.minInterpreterScore,
    names,
  };
}

export async function applyAutoAssign(
  actorPersonId: string,
  opts: { termId: string; departmentId: string; additions: readonly AutoAssignAddition[] },
): Promise<{ applied: number; skipped: number }> {
  await requireScope(actorPersonId, opts.departmentId);

  let applied = 0;
  let skipped = 0;
  for (const addition of opts.additions) {
    try {
      await setAssignment(actorPersonId, {
        termId: opts.termId,
        departmentId: opts.departmentId,
        dateKey: addition.dateKey,
        personId: addition.memberId,
        role: "VOLUNTEER",
      });
      applied += 1;
    } catch (err) {
      // A row the rules refuse is skipped, not fatal: see the file header.
      if (err instanceof BuilderValidationError || err instanceof BuilderForbiddenError) {
        skipped += 1;
        continue;
      }
      throw err;
    }
  }

  await recordAudit({
    actorPersonId,
    action: "schedule.auto_assign",
    entityType: "Department",
    entityId: opts.departmentId,
    after: { termId: opts.termId, proposed: opts.additions.length, applied, skipped },
  });

  return { applied, skipped };
}
