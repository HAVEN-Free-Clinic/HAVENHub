/**
 * Per-person count loaders for count-kind audience fields.
 *
 * Every loader obeys one rule that is easy to get wrong and expensive when
 * missed: the returned map contains an entry for EVERY candidate person,
 * defaulting to zero, not only for people who have rows. Without that, a
 * "fewer than N" comparison silently excludes everyone with none, which is
 * usually the exact cohort the campaign is trying to reach.
 *
 * Each loader is a table scan, so resolveAudience runs only the ones an
 * audience actually names.
 */
import { prisma } from "@/platform/db";
import type { CountLoader } from "./types";

/** Every ACTIVE person, seeded to zero. The universe each loader fills in. */
async function zeroedByPerson(): Promise<Map<string, number>> {
  const people = await prisma.person.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
  });
  return new Map(people.map((p) => [p.id, 0]));
}

/**
 * With no active term, a "this term" count is unanswerable. Return an EMPTY map
 * rather than a zeroed one: an empty map makes countWhere match nobody, while a
 * zeroed map would make "fewer than 3 shifts" match the entire roster.
 */
function noTerm(activeTermId: string | null): boolean {
  return activeTermId === null;
}

export const shiftCountThisTerm: CountLoader = async ({ activeTermId }) => {
  if (noTerm(activeTermId)) return new Map();
  const counts = await zeroedByPerson();
  const rows = await prisma.shiftAssignment.groupBy({
    by: ["personId"],
    where: { termId: activeTermId! },
    _count: { _all: true },
  });
  for (const r of rows) if (counts.has(r.personId)) counts.set(r.personId, r._count._all);
  return counts;
};

export const attendanceCountThisTerm: CountLoader = async ({ activeTermId }) => {
  if (noTerm(activeTermId)) return new Map();
  const counts = await zeroedByPerson();
  const rows = await prisma.clinicAttendance.groupBy({
    by: ["personId"],
    where: { termId: activeTermId! },
    _count: { _all: true },
  });
  for (const r of rows) if (counts.has(r.personId)) counts.set(r.personId, r._count._all);
  return counts;
};

/**
 * Assigned clinic dates with no attendance row on the SAME date.
 *
 * Compared by UTC day key rather than raw timestamp, because both
 * ShiftAssignment.clinicDate and ClinicAttendance.clinicDate are noon-UTC
 * anchored calendar dates (see their schema comments). ClinicAttendance
 * .checkedInAt is a true instant and is deliberately not used here.
 */
export const noShowCountThisTerm: CountLoader = async ({ activeTermId }) => {
  if (noTerm(activeTermId)) return new Map();
  const counts = await zeroedByPerson();

  const [assigned, attended] = await Promise.all([
    prisma.shiftAssignment.findMany({
      where: { termId: activeTermId! },
      select: { personId: true, clinicDate: true },
    }),
    prisma.clinicAttendance.findMany({
      where: { termId: activeTermId! },
      select: { personId: true, clinicDate: true },
    }),
  ]);

  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const attendedKeys = new Set(attended.map((a) => `${a.personId}:${dayKey(a.clinicDate)}`));

  for (const a of assigned) {
    if (!counts.has(a.personId)) continue;
    if (attendedKeys.has(`${a.personId}:${dayKey(a.clinicDate)}`)) continue;
    counts.set(a.personId, (counts.get(a.personId) ?? 0) + 1);
  }
  return counts;
};

export const upcomingShiftCount: CountLoader = async ({ activeTermId }) => {
  if (noTerm(activeTermId)) return new Map();
  const counts = await zeroedByPerson();
  // Clinic dates are noon-UTC anchored, so "today or later" is the start of
  // today's UTC day; a noon anchor on today sorts after it.
  const startOfToday = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  const rows = await prisma.shiftAssignment.groupBy({
    by: ["personId"],
    where: { termId: activeTermId!, clinicDate: { gte: startOfToday } },
    _count: { _all: true },
  });
  for (const r of rows) if (counts.has(r.personId)) counts.set(r.personId, r._count._all);
  return counts;
};
