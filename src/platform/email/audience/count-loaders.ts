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
import { startOfDayOffsetFromNow } from "./zoned-day";

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
 * Assigned clinic DAYS with no attendance row on the SAME date, for the SAME
 * person.
 *
 * Compared by UTC day key rather than raw timestamp, because both
 * ShiftAssignment.clinicDate and ClinicAttendance.clinicDate are noon-UTC
 * anchored calendar dates (see their schema comments). ClinicAttendance
 * .checkedInAt is a true instant and is deliberately not used here.
 *
 * Counted by DISTINCT (person, day) pair, not by raw ShiftAssignment row:
 * ShiftAssignment is unique on (termId, departmentId, clinicDate, personId),
 * not (termId, clinicDate, personId), so one person can hold two assignment
 * rows on the same clinicDate in two departments. A no-show is a day someone
 * didn't attend, not a row someone wasn't attached to, and ClinicAttendance
 * itself is unique on (termId, clinicDate, personId) -- one row per person
 * per clinic day -- so counting anything other than distinct days would
 * produce a no-show number that can never be compared against an attendance
 * count computed per day.
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

  const assignedDaysByPerson = new Map<string, Set<string>>();
  for (const a of assigned) {
    const day = dayKey(a.clinicDate);
    let days = assignedDaysByPerson.get(a.personId);
    if (!days) {
      days = new Set();
      assignedDaysByPerson.set(a.personId, days);
    }
    days.add(day);
  }

  for (const [personId, days] of assignedDaysByPerson) {
    if (!counts.has(personId)) continue;
    let noShows = 0;
    for (const day of days) if (!attendedKeys.has(`${personId}:${day}`)) noShows++;
    counts.set(personId, noShows);
  }
  return counts;
};

/**
 * Active-term ShiftAssignment rows with `clinicDate` at or after "today", in
 * the clinic's configured display ZONE, not the server's UTC calendar day.
 *
 * The cutoff is derived from `ctx.now`/`ctx.zone`, the SAME per-run clock and
 * zone every other relative-date path in this codebase resolves through (see
 * dateWhere in operators.ts), rather than a fresh `new Date()`: reading the
 * real wall clock here would ignore the clock a recurring campaign's tests
 * and reruns depend on, and comparing by UTC would misclassify a shift as
 * "not upcoming" for hours every evening once the zone falls behind UTC --
 * exactly the hours someone is likely to check.
 */
export const upcomingShiftCount: CountLoader = async ({ activeTermId, now, zone }) => {
  if (noTerm(activeTermId)) return new Map();
  const counts = await zeroedByPerson();
  const startOfToday = startOfDayOffsetFromNow(now, 0, zone);
  if (!startOfToday) {
    // Unreachable for a real Date and a validated DisplayTimeZone; a wiring
    // bug surfacing loudly beats silently mis-scoping "upcoming" to everyone
    // or no one.
    throw new Error("upcomingShiftCount: could not resolve the start of today in the configured zone");
  }
  const rows = await prisma.shiftAssignment.groupBy({
    by: ["personId"],
    where: { termId: activeTermId!, clinicDate: { gte: startOfToday } },
    _count: { _all: true },
  });
  for (const r of rows) if (counts.has(r.personId)) counts.set(r.personId, r._count._all);
  return counts;
};
