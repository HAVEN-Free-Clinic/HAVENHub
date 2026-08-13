/**
 * Board meeting attendance for directors.
 *
 * The director onboarding contract states that two unexcused absences equal one
 * strike, so this is not a standalone log: it is the evidence behind a strike
 * request. It surfaces an unexcused count to a human and stops there. Creating
 * the strike stays a deliberate act in the incidents module, matching the
 * strike-limit decision there, because a membership consequence driven
 * automatically off a count is both a policy call the code should not make and
 * hard to reverse.
 *
 * The roster is resolved LIVE from ACTIVE DIRECTOR memberships rather than
 * snapshotted at meeting creation, mirroring how the schedule builder resolves
 * its roster. A director who joins mid-term therefore appears on meetings
 * created before they arrived, with no attendance recorded, which reads as "not
 * recorded" rather than as an absence.
 */

import type { BoardAttendanceStatus } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";

export class BoardAttendanceForbiddenError extends Error {
  constructor(message = "You do not have permission to manage board attendance.") {
    super(message);
    this.name = "BoardAttendanceForbiddenError";
  }
}

export class BoardAttendanceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardAttendanceValidationError";
  }
}

export const BOARD_ATTENDANCE_STATUSES: BoardAttendanceStatus[] = ["PRESENT", "EXCUSED", "ABSENT"];

async function assertManager(actorPersonId: string): Promise<void> {
  if (!(await can(actorPersonId, "volunteers.manage_board_attendance"))) {
    throw new BoardAttendanceForbiddenError();
  }
}

/**
 * Anchors a calendar date at noon UTC, the convention every other date marker in
 * this schema uses (Term.clinicDates, ShiftAssignment.clinicDate). Storing a
 * midnight-UTC value would render as the previous day in every US zone.
 */
function anchorDate(dateKey: string): Date {
  const d = new Date(`${dateKey}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new BoardAttendanceValidationError(`"${dateKey}" is not a valid date.`);
  }
  return d;
}

export async function createMeeting(
  actorPersonId: string,
  input: { termId: string; dateKey: string; title?: string | null; notes?: string | null },
): Promise<{ id: string }> {
  await assertManager(actorPersonId);
  const meetingDate = anchorDate(input.dateKey);

  const term = await prisma.term.findUnique({ where: { id: input.termId }, select: { id: true } });
  if (!term) throw new BoardAttendanceValidationError("Term not found.");

  const existing = await prisma.boardMeeting.findUnique({
    where: { termId_meetingDate: { termId: term.id, meetingDate } },
    select: { id: true },
  });
  if (existing) {
    throw new BoardAttendanceValidationError("A board meeting already exists on that date.");
  }

  const created = await prisma.boardMeeting.create({
    data: {
      termId: term.id,
      meetingDate,
      title: input.title?.trim() || null,
      notes: input.notes?.trim() || null,
    },
    select: { id: true },
  });

  await recordAudit({
    actorPersonId,
    action: "board_meeting.create",
    entityType: "BoardMeeting",
    entityId: created.id,
    after: { termId: term.id, dateKey: input.dateKey, title: input.title?.trim() || null },
  });
  return created;
}

export type BoardRosterRow = {
  personId: string;
  name: string;
  departmentNames: string[];
  /** null when nobody has recorded this person for this meeting yet. */
  status: BoardAttendanceStatus | null;
  note: string | null;
};

/**
 * The director roster for one meeting, with whatever has been recorded so far.
 *
 * Everyone holding an ACTIVE DIRECTOR membership in the meeting's term appears,
 * whether or not they have a row, so the recording UI lists who still needs
 * marking rather than only who has been marked.
 */
export async function meetingRoster(meetingId: string): Promise<BoardRosterRow[]> {
  const meeting = await prisma.boardMeeting.findUnique({
    where: { id: meetingId },
    select: { termId: true },
  });
  if (!meeting) throw new BoardAttendanceValidationError("Board meeting not found.");

  const [memberships, recorded] = await Promise.all([
    prisma.termMembership.findMany({
      where: { termId: meeting.termId, kind: "DIRECTOR", status: "ACTIVE" },
      select: {
        personId: true,
        person: { select: { name: true } },
        department: { select: { name: true } },
      },
    }),
    prisma.boardMeetingAttendance.findMany({
      where: { meetingId },
      select: { personId: true, status: true, note: true },
    }),
  ]);

  const byPerson = new Map(recorded.map((r) => [r.personId, r]));

  // One row per PERSON, not per membership: a director of two departments holds
  // two memberships and attends one meeting once.
  const rows = new Map<string, BoardRosterRow>();
  for (const m of memberships) {
    const existing = rows.get(m.personId);
    if (existing) {
      existing.departmentNames.push(m.department.name);
      continue;
    }
    const rec = byPerson.get(m.personId);
    rows.set(m.personId, {
      personId: m.personId,
      name: m.person.name,
      departmentNames: [m.department.name],
      status: rec?.status ?? null,
      note: rec?.note ?? null,
    });
  }

  return [...rows.values()]
    .map((r) => ({ ...r, departmentNames: r.departmentNames.sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Records or updates one director's attendance. Idempotent: recording the same
 * status twice is a no-op update rather than a duplicate row.
 */
export async function markAttendance(
  actorPersonId: string,
  input: { meetingId: string; personId: string; status: BoardAttendanceStatus; note?: string | null },
): Promise<void> {
  await assertManager(actorPersonId);
  if (!BOARD_ATTENDANCE_STATUSES.includes(input.status)) {
    throw new BoardAttendanceValidationError(`Invalid status "${input.status}".`);
  }

  const meeting = await prisma.boardMeeting.findUnique({
    where: { id: input.meetingId },
    select: { id: true },
  });
  if (!meeting) throw new BoardAttendanceValidationError("Board meeting not found.");

  const before = await prisma.boardMeetingAttendance.findUnique({
    where: { meetingId_personId: { meetingId: input.meetingId, personId: input.personId } },
    select: { status: true },
  });

  await prisma.boardMeetingAttendance.upsert({
    where: { meetingId_personId: { meetingId: input.meetingId, personId: input.personId } },
    create: {
      meetingId: input.meetingId,
      personId: input.personId,
      status: input.status,
      note: input.note?.trim() || null,
      recordedById: actorPersonId,
    },
    update: {
      status: input.status,
      note: input.note?.trim() || null,
      recordedById: actorPersonId,
      recordedAt: new Date(),
    },
  });

  await recordAudit({
    actorPersonId,
    action: "board_meeting.mark_attendance",
    entityType: "BoardMeeting",
    entityId: input.meetingId,
    before: { personId: input.personId, status: before?.status ?? null },
    after: { personId: input.personId, status: input.status },
  });
}

/**
 * Unexcused absences per person for a term, for the directors deciding whether
 * to raise a strike.
 *
 * Counts ABSENT only. EXCUSED is explicitly not an unexcused absence, and a
 * missing row is "not recorded" rather than an absence, so neither inflates the
 * number the strike conversation starts from.
 */
export async function unexcusedAbsenceCounts(termId: string): Promise<Map<string, number>> {
  const groups = await prisma.boardMeetingAttendance.groupBy({
    by: ["personId"],
    where: { status: "ABSENT", meeting: { termId } },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.personId, g._count._all]));
}

export type BoardMeetingSummary = {
  id: string;
  meetingDate: Date;
  title: string | null;
  recordedCount: number;
  absentCount: number;
};

/** Meetings for a term, newest first, with how much has been recorded. */
export async function listMeetings(termId: string): Promise<BoardMeetingSummary[]> {
  const meetings = await prisma.boardMeeting.findMany({
    where: { termId },
    orderBy: { meetingDate: "desc" },
    select: {
      id: true,
      meetingDate: true,
      title: true,
      attendance: { select: { status: true } },
    },
  });
  return meetings.map((m) => ({
    id: m.id,
    meetingDate: m.meetingDate,
    title: m.title,
    recordedCount: m.attendance.length,
    absentCount: m.attendance.filter((a) => a.status === "ABSENT").length,
  }));
}
