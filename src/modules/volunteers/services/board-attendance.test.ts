import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import {
  createMeeting,
  meetingRoster,
  markAttendance,
  unexcusedAbsenceCounts,
  listMeetings,
  BoardAttendanceForbiddenError,
  BoardAttendanceValidationError,
} from "./board-attendance";

const ACTOR = "board-actor";

async function manager() {
  await prisma.person.create({ data: { id: ACTOR, name: "Board Manager" } });
  const role = await prisma.role.create({
    data: {
      name: `r-${Date.now()}-${Math.random()}`,
      isSystem: false,
      grants: { create: [{ permission: "volunteers.manage_board_attendance" }] },
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, personId: ACTOR, termId: null } });
}

async function term() {
  return prisma.term.create({
    data: {
      code: "FA26",
      name: "Fall 2026",
      startDate: new Date("2026-09-01T12:00:00Z"),
      endDate: new Date("2026-12-15T12:00:00Z"),
      status: "ACTIVE",
    },
  });
}

async function director(name: string, termId: string, departmentCode: string) {
  const person = await prisma.person.create({ data: { name } });
  const dept = await prisma.department.upsert({
    where: { code: departmentCode },
    update: {},
    create: { code: departmentCode, name: `${departmentCode} Dept` },
  });
  await prisma.termMembership.create({
    data: { personId: person.id, termId, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" },
  });
  return person;
}

beforeEach(resetDb);

describe("createMeeting", () => {
  it("requires the permission", async () => {
    const t = await term();
    await prisma.person.create({ data: { id: ACTOR, name: "Nobody" } });
    await expect(
      createMeeting(ACTOR, { termId: t.id, dateKey: "2026-09-10" }),
    ).rejects.toBeInstanceOf(BoardAttendanceForbiddenError);
  });

  // Noon-UTC, like every other calendar marker in the schema. A midnight value
  // would render as the previous day in every US zone.
  it("anchors the meeting date at noon UTC", async () => {
    await manager();
    const t = await term();
    const { id } = await createMeeting(ACTOR, { termId: t.id, dateKey: "2026-09-10" });
    const row = await prisma.boardMeeting.findUniqueOrThrow({ where: { id } });
    expect(row.meetingDate.toISOString()).toBe("2026-09-10T12:00:00.000Z");
  });

  it("refuses a duplicate meeting on the same date", async () => {
    await manager();
    const t = await term();
    await createMeeting(ACTOR, { termId: t.id, dateKey: "2026-09-10" });
    await expect(
      createMeeting(ACTOR, { termId: t.id, dateKey: "2026-09-10" }),
    ).rejects.toBeInstanceOf(BoardAttendanceValidationError);
  });
});

describe("meetingRoster", () => {
  it("lists every active director, recorded or not", async () => {
    await manager();
    const t = await term();
    await director("Ann Adams", t.id, "EXEC");
    await director("Bob Brown", t.id, "ITCM");
    const { id } = await createMeeting(ACTOR, { termId: t.id, dateKey: "2026-09-10" });

    const roster = await meetingRoster(id);
    expect(roster.map((r) => r.name)).toEqual(["Ann Adams", "Bob Brown"]);
    // Nobody marked yet: null, NOT absent.
    expect(roster.every((r) => r.status === null)).toBe(true);
  });

  // A director of two departments attends one meeting once.
  it("lists a two-department director exactly once, with both departments", async () => {
    await manager();
    const t = await term();
    const person = await director("Dual Role", t.id, "EXEC");
    const second = await prisma.department.upsert({
      where: { code: "ITCM" }, update: {}, create: { code: "ITCM", name: "IT" },
    });
    await prisma.termMembership.create({
      data: { personId: person.id, termId: t.id, departmentId: second.id, kind: "DIRECTOR", status: "ACTIVE" },
    });
    const { id } = await createMeeting(ACTOR, { termId: t.id, dateKey: "2026-09-10" });

    const roster = await meetingRoster(id);
    expect(roster).toHaveLength(1);
    expect(roster[0].departmentNames).toEqual(["EXEC Dept", "IT"]);
  });

  it("excludes volunteers and inactive directors", async () => {
    await manager();
    const t = await term();
    await director("Real Director", t.id, "EXEC");
    const vol = await prisma.person.create({ data: { name: "A Volunteer" } });
    const dept = await prisma.department.findFirstOrThrow({ where: { code: "EXEC" } });
    await prisma.termMembership.create({
      data: { personId: vol.id, termId: t.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
    });
    const gone = await prisma.person.create({ data: { name: "Departed Director" } });
    await prisma.termMembership.create({
      data: { personId: gone.id, termId: t.id, departmentId: dept.id, kind: "DIRECTOR", status: "REMOVED" },
    });
    const { id } = await createMeeting(ACTOR, { termId: t.id, dateKey: "2026-09-10" });

    const roster = await meetingRoster(id);
    expect(roster.map((r) => r.name)).toEqual(["Real Director"]);
  });

  it("keeps a director who was marked and then removed from the roster", async () => {
    await manager();
    const t = await term();
    const gone = await director("Departed Director", t.id, "EXEC");
    const { id } = await createMeeting(ACTOR, { termId: t.id, dateKey: "2026-09-10" });
    await markAttendance(ACTOR, { meetingId: id, personId: gone.id, status: "ABSENT" });
    await prisma.termMembership.updateMany({ where: { personId: gone.id }, data: { status: "REMOVED" } });

    // Dropping the row here would take the recorded evidence with it, which is
    // exactly the evidence a strike conversation starts from.
    const roster = await meetingRoster(id);
    expect(roster).toMatchObject([{ name: "Departed Director", status: "ABSENT", departmentNames: ["EXEC Dept"] }]);
  });

  it("lists someone with a mark but no membership in the term", async () => {
    // The historical import writes marks into a live term without writing
    // memberships (see platform/board-attendance/import/load.ts). Those rows
    // would otherwise be invisible on the page that shows the meeting.
    await manager();
    const t = await term();
    const imported = await prisma.person.create({ data: { name: "Imported Director", status: "OFFBOARDED" } });
    const { id } = await createMeeting(ACTOR, { termId: t.id, dateKey: "2026-09-10" });
    await markAttendance(ACTOR, { meetingId: id, personId: imported.id, status: "PRESENT" });

    const roster = await meetingRoster(id);
    expect(roster).toMatchObject([{ name: "Imported Director", status: "PRESENT", departmentNames: [] }]);
  });
});

describe("markAttendance", () => {
  it("records a status and is idempotent on re-record", async () => {
    await manager();
    const t = await term();
    const d = await director("Ann Adams", t.id, "EXEC");
    const { id } = await createMeeting(ACTOR, { termId: t.id, dateKey: "2026-09-10" });

    await markAttendance(ACTOR, { meetingId: id, personId: d.id, status: "ABSENT" });
    await markAttendance(ACTOR, { meetingId: id, personId: d.id, status: "PRESENT", note: "arrived late" });

    const rows = await prisma.boardMeetingAttendance.findMany({ where: { meetingId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PRESENT");
    expect(rows[0].note).toBe("arrived late");
  });

  it("requires the permission", async () => {
    await manager();
    const t = await term();
    const d = await director("Ann Adams", t.id, "EXEC");
    const { id } = await createMeeting(ACTOR, { termId: t.id, dateKey: "2026-09-10" });
    const outsider = await prisma.person.create({ data: { name: "Outsider" } });

    await expect(
      markAttendance(outsider.id, { meetingId: id, personId: d.id, status: "ABSENT" }),
    ).rejects.toBeInstanceOf(BoardAttendanceForbiddenError);
  });
});

describe("unexcusedAbsenceCounts", () => {
  // The whole point: this number feeds a strike conversation, so it must count
  // only deliberate ABSENT marks.
  it("counts ABSENT only, never EXCUSED and never a missing record", async () => {
    await manager();
    const t = await term();
    const ann = await director("Ann Adams", t.id, "EXEC");
    const bob = await director("Bob Brown", t.id, "ITCM");
    const cara = await director("Cara Cole", t.id, "SRR");

    const m1 = await createMeeting(ACTOR, { termId: t.id, dateKey: "2026-09-10" });
    const m2 = await createMeeting(ACTOR, { termId: t.id, dateKey: "2026-09-24" });

    await markAttendance(ACTOR, { meetingId: m1.id, personId: ann.id, status: "ABSENT" });
    await markAttendance(ACTOR, { meetingId: m2.id, personId: ann.id, status: "ABSENT" });
    await markAttendance(ACTOR, { meetingId: m1.id, personId: bob.id, status: "EXCUSED" });
    await markAttendance(ACTOR, { meetingId: m2.id, personId: bob.id, status: "EXCUSED" });
    // Cara is never recorded at all.

    const counts = await unexcusedAbsenceCounts(t.id);
    expect(counts.get(ann.id)).toBe(2);
    expect(counts.get(bob.id)).toBeUndefined();
    expect(counts.get(cara.id)).toBeUndefined();
  });

  it("does not count absences from another term", async () => {
    await manager();
    const t = await term();
    const other = await prisma.term.create({
      data: {
        code: "SP26", name: "Spring", startDate: new Date("2026-01-01T12:00:00Z"),
        endDate: new Date("2026-05-01T12:00:00Z"), status: "ARCHIVED",
      },
    });
    const ann = await director("Ann Adams", t.id, "EXEC");
    const m = await createMeeting(ACTOR, { termId: other.id, dateKey: "2026-02-10" });
    await markAttendance(ACTOR, { meetingId: m.id, personId: ann.id, status: "ABSENT" });

    expect((await unexcusedAbsenceCounts(t.id)).get(ann.id)).toBeUndefined();
    expect((await unexcusedAbsenceCounts(other.id)).get(ann.id)).toBe(1);
  });
});

describe("listMeetings", () => {
  it("returns meetings newest first with recorded and absent counts", async () => {
    await manager();
    const t = await term();
    const ann = await director("Ann Adams", t.id, "EXEC");
    const older = await createMeeting(ACTOR, { termId: t.id, dateKey: "2026-09-10" });
    await createMeeting(ACTOR, { termId: t.id, dateKey: "2026-09-24" });
    await markAttendance(ACTOR, { meetingId: older.id, personId: ann.id, status: "ABSENT" });

    const meetings = await listMeetings(t.id);
    expect(meetings.map((m) => m.meetingDate.toISOString().slice(0, 10))).toEqual([
      "2026-09-24",
      "2026-09-10",
    ]);
    expect(meetings[1].recordedCount).toBe(1);
    expect(meetings[1].absentCount).toBe(1);
    expect(meetings[0].recordedCount).toBe(0);
  });
});
