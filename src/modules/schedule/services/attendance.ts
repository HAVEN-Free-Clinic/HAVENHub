import type { CheckInMethod } from "@prisma/client";
import { prisma, isUniqueConstraintError } from "@/platform/db";
import { getActiveTerm } from "@/platform/terms/active-term";
import { getSetting } from "@/platform/settings/service";
import { isoDateKey } from "@/platform/dates";
import { displayTodayKey } from "@/platform/dates/today";
import { evaluateFence, type Coords } from "@/modules/schedule/engine/geofence";

export type CheckInFailureReason =
  | "PERMISSION_DENIED"
  | "POSITION_UNAVAILABLE"
  | "TIMEOUT"
  | "TOO_IMPRECISE"
  | "OUT_OF_RANGE"
  | "NOT_ASSIGNED"
  | "NOT_A_CLINIC_DAY"
  | "NOT_ELIGIBLE"
  | "FENCE_UNCONFIGURED";

export type CheckInResult =
  | { ok: true; alreadyCheckedIn: boolean; checkedInAt: Date; method: CheckInMethod }
  | { ok: false; reason: CheckInFailureReason };

export type CheckInState = {
  clinicDate: Date | null;
  termId: string | null;
  assignmentCount: number;
  allRemote: boolean;
  existing: { checkedInAt: Date; method: CheckInMethod } | null;
};

/**
 * Resolve today's clinic date for the live term, as the display-zone calendar
 * day. Returns null when there is no active term or today is not a clinic date.
 */
async function todaysClinicDate(now: Date): Promise<{ termId: string; clinicDate: Date } | null> {
  const term = await getActiveTerm();
  if (!term) return null;
  const todayKey = await displayTodayKey(now);
  const match = term.clinicDates.find((d) => isoDateKey(d) === todayKey);
  return match ? { termId: term.id, clinicDate: match } : null;
}

/** Everything the check-in page needs to render, in one call. */
export async function getCheckInState(personId: string, now: Date = new Date()): Promise<CheckInState> {
  const today = await todaysClinicDate(now);
  if (!today) {
    return { clinicDate: null, termId: null, assignmentCount: 0, allRemote: false, existing: null };
  }

  const [assignments, existing] = await Promise.all([
    prisma.shiftAssignment.findMany({
      where: { termId: today.termId, clinicDate: today.clinicDate, personId },
      select: { remote: true },
    }),
    prisma.clinicAttendance.findUnique({
      where: {
        termId_clinicDate_personId: {
          termId: today.termId,
          clinicDate: today.clinicDate,
          personId,
        },
      },
      select: { checkedInAt: true, method: true },
    }),
  ]);

  return {
    clinicDate: today.clinicDate,
    termId: today.termId,
    assignmentCount: assignments.length,
    // Conjunctive over a NON-EMPTY set. "every assignment is remote" is
    // vacuously true for a person with none, which would hand a fence-free
    // check-in to exactly the unscheduled people NOT_ASSIGNED exists to stop.
    allRemote: assignments.length > 0 && assignments.every((a) => a.remote),
    existing,
  };
}

/**
 * Self check-in. `position` is null when the client could not obtain a fix; the
 * caller maps the browser's own error codes to a more specific reason before
 * showing the user anything.
 *
 * The client never decides. It reports a position; this function owns the rule,
 * the verdict, and the write.
 */
export async function checkInSelf(
  personId: string,
  position: { coords: Coords; accuracyMeters: number } | null,
  now: Date = new Date(),
): Promise<CheckInResult> {
  // Re-validate the person at write time rather than trusting the session or a
  // previously-issued assignment, mirroring magic-link verification.
  const person = await prisma.person.findUnique({
    where: { id: personId },
    select: { status: true },
  });
  if (!person || person.status !== "ACTIVE") return { ok: false, reason: "NOT_ELIGIBLE" };

  const state = await getCheckInState(personId, now);
  if (!state.clinicDate || !state.termId) return { ok: false, reason: "NOT_A_CLINIC_DAY" };

  if (state.existing) {
    return {
      ok: true,
      alreadyCheckedIn: true,
      checkedInAt: state.existing.checkedInAt,
      method: state.existing.method,
    };
  }

  // Order matters: NOT_ASSIGNED before the remote waiver.
  if (state.assignmentCount === 0) return { ok: false, reason: "NOT_ASSIGNED" };

  let method: CheckInMethod;
  let distanceMeters: number | null = null;
  let accuracyMeters: number | null = null;

  if (state.allRemote) {
    method = "SELF_REMOTE";
  } else {
    if (!position) return { ok: false, reason: "POSITION_UNAVAILABLE" };

    const fence = await resolveFence();
    if (!fence) return { ok: false, reason: "FENCE_UNCONFIGURED" };

    const verdict = evaluateFence({
      position: position.coords,
      accuracyMeters: position.accuracyMeters,
      centre: fence.centre,
      radiusMeters: fence.radiusMeters,
      maxAccuracyMeters: fence.maxAccuracyMeters,
    });
    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    method = "SELF_GEO";
    distanceMeters = verdict.distanceMeters;
    accuracyMeters = Math.round(position.accuracyMeters);
  }

  return writeAttendance({
    termId: state.termId,
    clinicDate: state.clinicDate,
    personId,
    method,
    distanceMeters,
    accuracyMeters,
    recordedById: null,
    note: null,
  });
}

/**
 * Resolve the configured fence. Returns null when any value is missing or not a
 * finite number, which makes self check-in FAIL CLOSED. Failing open would mean
 * a geofence that silently passes everyone, which is worse than having none
 * because it would be trusted.
 */
async function resolveFence(): Promise<{
  centre: Coords;
  radiusMeters: number;
  maxAccuracyMeters: number;
} | null> {
  const [latitude, longitude, radiusMeters, maxAccuracyMeters] = await Promise.all([
    getSetting<number>("clinic.checkInLatitude"),
    getSetting<number>("clinic.checkInLongitude"),
    getSetting<number>("clinic.checkInRadiusMeters"),
    getSetting<number>("clinic.checkInMaxAccuracyMeters"),
  ]);

  const values = [latitude, longitude, radiusMeters, maxAccuracyMeters];
  if (values.some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
  if (radiusMeters <= 0 || maxAccuracyMeters <= 0) return null;

  return { centre: { latitude, longitude }, radiusMeters, maxAccuracyMeters };
}

/**
 * Insert the row, tolerating the race where two taps land at once. The unique
 * constraint is the real guard; on collision we return the winning row so both
 * callers see the same arrival time.
 */
export async function writeAttendance(input: {
  termId: string;
  clinicDate: Date;
  personId: string;
  method: CheckInMethod;
  distanceMeters: number | null;
  accuracyMeters: number | null;
  recordedById: string | null;
  note: string | null;
}): Promise<CheckInResult> {
  const key = {
    termId_clinicDate_personId: {
      termId: input.termId,
      clinicDate: input.clinicDate,
      personId: input.personId,
    },
  };

  const existing = await prisma.clinicAttendance.findUnique({
    where: key,
    select: { checkedInAt: true, method: true },
  });
  if (existing) {
    return { ok: true, alreadyCheckedIn: true, checkedInAt: existing.checkedInAt, method: existing.method };
  }

  try {
    const row = await prisma.clinicAttendance.create({
      data: {
        termId: input.termId,
        clinicDate: input.clinicDate,
        personId: input.personId,
        method: input.method,
        distanceMeters: input.distanceMeters,
        accuracyMeters: input.accuracyMeters,
        recordedById: input.recordedById,
        note: input.note,
      },
      select: { checkedInAt: true, method: true },
    });
    return { ok: true, alreadyCheckedIn: false, checkedInAt: row.checkedInAt, method: row.method };
  } catch (error) {
    // Only a unique-constraint collision means "lost the race": someone else's
    // write beat ours to the same (termId, clinicDate, personId) row between our
    // find and our create, and their row is the true arrival record. Anything
    // else (FK violation, pool timeout, connection reset) is a real failure and
    // must propagate -- swallowing it here would let an unrelated write failure
    // get reported as a success, potentially with a DIFFERENT person's method
    // once Task 4's staff override calls this same helper concurrently.
    if (!isUniqueConstraintError(error)) throw error;

    const winner = await prisma.clinicAttendance.findUnique({
      where: key,
      select: { checkedInAt: true, method: true },
    });
    if (!winner) {
      throw new Error("clinic attendance unique collision but no row exists", { cause: error });
    }
    return { ok: true, alreadyCheckedIn: true, checkedInAt: winner.checkedInAt, method: winner.method };
  }
}

export type AttendanceRow = {
  checkedInAt: Date;
  method: CheckInMethod;
  recordedById: string | null;
};

/**
 * Director override: record that someone is here when self check-in could not
 * happen (denied permission, no usable fix, or simply no assignment).
 *
 * Deliberately allows an UNASSIGNED subject. Informal covers happen, and a board
 * that cannot show them is visibly wrong. The row carries no assignment, so it
 * never enters the no-show denominator, which stays measured against
 * ShiftAssignment.
 *
 * Caller must have already enforced `schedule.manage_attendance`.
 */
export async function markPresent(
  actorId: string,
  personId: string,
  opts: { note?: string } = {},
  now: Date = new Date(),
): Promise<CheckInResult> {
  const person = await prisma.person.findUnique({
    where: { id: personId },
    select: { status: true },
  });
  if (!person || person.status !== "ACTIVE") return { ok: false, reason: "NOT_ELIGIBLE" };

  const today = await todaysClinicDate(now);
  if (!today) return { ok: false, reason: "NOT_A_CLINIC_DAY" };

  return writeAttendance({
    termId: today.termId,
    clinicDate: today.clinicDate,
    personId,
    method: "STAFF",
    distanceMeters: null,
    accuracyMeters: null,
    recordedById: actorId,
    note: opts.note?.trim() || null,
  });
}

/**
 * Remove today's attendance row for a person, so a misclick can be corrected.
 * No-op when there is nothing to remove.
 *
 * Caller must have already enforced `schedule.manage_attendance`.
 */
export async function undoAttendance(personId: string, now: Date = new Date()): Promise<void> {
  const today = await todaysClinicDate(now);
  if (!today) return;

  await prisma.clinicAttendance.deleteMany({
    where: { termId: today.termId, clinicDate: today.clinicDate, personId },
  });
}

/** Attendance for one clinic date, keyed by personId, for roster overlays. */
export async function attendanceForDate(
  termId: string,
  clinicDate: Date,
): Promise<Map<string, AttendanceRow>> {
  const rows = await prisma.clinicAttendance.findMany({
    where: { termId, clinicDate },
    select: { personId: true, checkedInAt: true, method: true, recordedById: true },
  });
  return new Map(
    rows.map((r) => [r.personId, { checkedInAt: r.checkedInAt, method: r.method, recordedById: r.recordedById }]),
  );
}
