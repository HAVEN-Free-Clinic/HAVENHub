import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { parseAttendanceSheet } from "./parse";
import { loadBoardAttendance } from "./load";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const noon = (iso: string) => new Date(`${iso}T12:00:00Z`);

async function department(code: string) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: { code, name: `${code} Dept` },
  });
}

function sheet(name: string, rows: unknown[][]) {
  return parseAttendanceSheet(name, rows);
}

const load = (sheets: ReturnType<typeof sheet>[], overwriteExisting = false) =>
  loadBoardAttendance(prisma, sheets, { overwriteExisting });

beforeEach(resetDb);

describe("loadBoardAttendance", () => {
  it("mints the archived terms a historical meeting needs, and only those", async () => {
    await department("BVHD");
    const report = await load([
      sheet("2025", [
        ["Department", "Name", d("2025-02-04")],
        ["Behavioral Health", "Yash Wadwekar", "Present"],
      ]),
    ]);

    expect(report.terms.created).toEqual(["SP25"]);
    const terms = await prisma.term.findMany({ select: { code: true, status: true } });
    // SP24/SU24/FA24/SU25/FA25 are in HISTORICAL_TERMS but no meeting reaches
    // them, so creating them would leave empty terms in the switcher.
    expect(terms).toEqual([{ code: "SP25", status: "ARCHIVED" }]);
  });

  it("files a January meeting under the fall term that held it", async () => {
    await department("BVHD");
    await load([
      sheet("2024", [
        ["Department", "Name", d("2025-01-07")],
        ["Behavioral Health", "Cathleen Liang", "Present"],
      ]),
    ]);
    const meeting = await prisma.boardMeeting.findFirstOrThrow({
      select: { meetingDate: true, term: { select: { code: true } } },
    });
    expect(meeting.term.code).toBe("FA24");
    expect(meeting.meetingDate).toEqual(noon("2025-01-07"));
  });

  it("creates unknown directors as OFFBOARDED and reuses people it recognizes", async () => {
    await department("EDUC");
    const known = await prisma.person.create({ data: { name: "Ammara Talib" } });

    const report = await load([
      sheet("2025", [
        ["Department", "Name", d("2025-02-04")],
        ["Education", "Anmara Talib", "Present"],
        ["Education", "Dina Garmroudi", "Absent"],
      ]),
    ]);

    expect(report.people.matched).toBe(1);
    expect(report.people.created).toEqual(["Dina Garmroudi"]);
    expect(report.people.aliased).toEqual([{ sheet: "Anmara Talib", canonical: "Ammara Talib" }]);

    const created = await prisma.person.findFirstOrThrow({ where: { name: "Dina Garmroudi" } });
    // A director from 2025 is a record of service, not an account: ACTIVE here
    // would put them back on every roster and status gate in the app.
    expect(created.status).toBe("OFFBOARDED");
    expect(created.netId).toBeNull();
    expect(await prisma.person.count()).toBe(2);
    expect(
      await prisma.boardMeetingAttendance.count({ where: { personId: known.id, status: "PRESENT" } }),
    ).toBe(1);
  });

  it("writes director memberships for a past term", async () => {
    const dept = await department("PNLC");
    await load([
      sheet("2025", [
        ["Department", "Name", d("2025-02-04")],
        ["LCC", "Gretchen Long", "Present"],
      ]),
    ]);
    const membership = await prisma.termMembership.findFirstOrThrow({
      select: { kind: true, status: true, departmentId: true, term: { select: { code: true, status: true } } },
    });
    expect(membership).toMatchObject({
      kind: "DIRECTOR",
      status: "ACTIVE",
      departmentId: dept.id,
      term: { code: "SP25", status: "ARCHIVED" },
    });
  });

  it("never writes a membership into a term that is still live", async () => {
    await department("PNLC");
    const live = await prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        startDate: noon("2026-05-30"),
        endDate: noon("2026-09-26"),
        status: "ACTIVE",
      },
    });
    await prisma.person.create({ data: { name: "Gretchen Long", status: "OFFBOARDED" } });

    const report = await load([
      sheet("2026", [
        ["Department", "Name", d("2026-06-02")],
        ["LCC", "Gretchen Long", "Present"],
      ]),
    ]);

    // The live roster is owned by the roster import and gated on Person.status
    // there. Writing into it from a spreadsheet would put an offboarded member
    // back on the current roster.
    expect(report.memberships.created).toBe(0);
    expect(report.memberships.skippedLiveTerm).toBe(1);
    expect(await prisma.termMembership.count()).toBe(0);
    // The mark itself still lands, which is the point of importing at all.
    expect(await prisma.boardMeetingAttendance.count({ where: { meeting: { termId: live.id } } })).toBe(1);
  });

  it("collapses a director marked on two department rows, keeping presence", async () => {
    await department("MDIC");
    await department("PNLC");
    const report = await load([
      sheet("2024", [
        ["Department", "Name", d("2024-02-06")],
        ["Medical Debt & Insurance Counseling", "Joanna Chen", "Absent"],
        ["LCC", "Joanna Chen", "Present"],
      ]),
    ]);

    expect(report.conflicts).toEqual([
      { name: "Joanna Chen", dateKey: "2024-02-06", kept: "PRESENT", saw: ["Absent", "Present"] },
    ]);
    const marks = await prisma.boardMeetingAttendance.findMany({ select: { status: true } });
    expect(marks).toEqual([{ status: "PRESENT" }]);
    // Both departments are still recorded: she directed both that term.
    expect(await prisma.termMembership.count()).toBe(2);
  });

  it("folds two sheets covering the same meeting into one mark", async () => {
    await department("PHLO");
    await load([
      sheet("2024-a", [
        ["Department", "Name", d("2024-05-14")],
        ["Lab", "Mamadou Jallow", "Present"],
      ]),
      sheet("2024-b", [
        ["Department", "Name", d("2024-05-14")],
        ["Lab", "Mamadou Jallow", "Present"],
      ]),
    ]);
    expect(await prisma.boardMeeting.count()).toBe(1);
    expect(await prisma.boardMeetingAttendance.count()).toBe(1);
  });

  it("does not create a meeting for a date column nobody was marked in", async () => {
    await department("EDUC");
    const report = await load([
      sheet("2025", [
        ["Department", "Name", d("2025-02-04"), d("2025-02-18")],
        ["Education", "Harsh Patel", "Present", null],
      ]),
    ]);
    expect(report.sheets[0].emptyColumns).toBe(1);
    const meetings = await prisma.boardMeeting.findMany({ select: { meetingDate: true } });
    expect(meetings).toEqual([{ meetingDate: noon("2025-02-04") }]);
  });

  it("is idempotent", async () => {
    await department("EDUC");
    const sheets = [
      sheet("2025", [
        ["Department", "Name", d("2025-02-04")],
        ["Education", "Harsh Patel", "Present"],
      ]),
    ];
    await load(sheets);
    const second = await load(sheets);

    expect(second.people.created).toEqual([]);
    expect(second.terms.created).toEqual([]);
    expect(second.meetings.created).toBe(0);
    expect(second.attendance.created).toBe(0);
    expect(second.attendance.unchanged).toBe(1);
    expect(await prisma.person.count()).toBe(1);
    expect(await prisma.boardMeetingAttendance.count()).toBe(1);
  });

  it("leaves a corrected mark alone unless asked to overwrite", async () => {
    await department("EDUC");
    const sheets = [
      sheet("2025", [
        ["Department", "Name", d("2025-02-04")],
        ["Education", "Harsh Patel", "Absent"],
      ]),
    ];
    await load(sheets);
    // An admin corrects the imported mark in the UI.
    await prisma.boardMeetingAttendance.updateMany({ data: { status: "EXCUSED", note: "called ahead" } });

    const kept = await load(sheets);
    expect(kept.attendance.keptExisting).toBe(1);
    expect(kept.attendance.updated).toBe(0);
    expect((await prisma.boardMeetingAttendance.findFirstOrThrow()).status).toBe("EXCUSED");

    const overwritten = await load(sheets, true);
    expect(overwritten.attendance.updated).toBe(1);
    expect((await prisma.boardMeetingAttendance.findFirstOrThrow()).status).toBe("ABSENT");
  });

  it("skips a row whose department the mapping does not know, but keeps the mark", async () => {
    await department("EDUC");
    const report = await load([
      sheet("2025", [
        ["Department", "Name", d("2025-02-04")],
        ["Ophthalmology", "Someone New", "Present"],
      ]),
    ]);
    expect(report.unmappedDepartments).toEqual(["Ophthalmology"]);
    expect(await prisma.termMembership.count()).toBe(0);
    expect(await prisma.boardMeetingAttendance.count()).toBe(1);
  });

  it("reports a date outside every term instead of inventing one", async () => {
    await department("EDUC");
    const report = await load([
      sheet("2027", [
        ["Department", "Name", d("2027-06-01")],
        ["Education", "Harsh Patel", "Present"],
      ]),
    ]);
    expect(report.unresolvedDates).toEqual(["2027-06-01"]);
    expect(await prisma.boardMeeting.count()).toBe(0);
    expect(await prisma.boardMeetingAttendance.count()).toBe(0);
  });

  it("skips a name two people answer to rather than picking one", async () => {
    await department("EDUC");
    await prisma.person.create({ data: { name: "Chris Smith" } });
    await prisma.person.create({ data: { name: "Chris Smith" } });

    const report = await load([
      sheet("2025", [
        ["Department", "Name", d("2025-02-04")],
        ["Education", "Chris Smith", "Absent"],
      ]),
    ]);
    expect(report.people.ambiguous).toEqual(["Chris Smith"]);
    expect(await prisma.boardMeetingAttendance.count()).toBe(0);
    expect(await prisma.person.count()).toBe(2);
  });

  it("adds to a meeting the hub already recorded rather than duplicating it", async () => {
    await department("EDUC");
    const term = await prisma.term.create({
      data: {
        code: "SU26",
        name: "Summer 2026",
        startDate: noon("2026-05-30"),
        endDate: noon("2026-09-26"),
        status: "ACTIVE",
      },
    });
    await prisma.boardMeeting.create({ data: { termId: term.id, meetingDate: noon("2026-08-11") } });

    const report = await load([
      sheet("2026", [
        ["Department", "Name", d("2026-08-11")],
        ["Education", "Harsh Patel", "Present"],
      ]),
    ]);
    expect(report.meetings.created).toBe(0);
    expect(report.meetings.existing).toBe(1);
    expect(await prisma.boardMeeting.count()).toBe(1);
    expect(await prisma.boardMeetingAttendance.count()).toBe(1);
  });

  it("records one audit entry naming what it wrote", async () => {
    await department("EDUC");
    await load([
      sheet("2025", [
        ["Department", "Name", d("2025-02-04")],
        ["Education", "Harsh Patel", "Present"],
      ]),
    ]);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "board_meeting.import" } });
    expect(audit.actorPersonId).toBeNull();
    expect(audit.after).toMatchObject({ termsCreated: ["SP25"], peopleCreated: 1 });
  });
});
