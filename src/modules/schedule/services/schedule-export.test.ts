import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import {
  buildScheduleWorkbook,
  loadScheduleExportRows,
  newcomerLabel,
  scheduleExportFilename,
  tagsLabel,
} from "./schedule-export";

const SEP_5 = new Date("2026-09-05T12:00:00.000Z");
const SEP_12 = new Date("2026-09-12T12:00:00.000Z");

async function seedBoard() {
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: SEP_5, endDate: SEP_12, status: "ACTIVE", clinicDates: [SEP_5, SEP_12] },
  });
  const rhd = await prisma.department.create({ data: { code: "RHD", name: "Reproductive Health" } });
  const other = await prisma.department.create({ data: { code: "PATS", name: "Patient Services" } });
  const approver = await prisma.person.create({ data: { name: "Approver", status: "ACTIVE" } });
  const cycle = await prisma.recruitmentCycle.create({
    data: { track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v", departments: ["RHD"], createdById: approver.id, status: "OPEN" },
  });
  return { term, rhd, other, approver, cycle };
}

async function seedFirstTimer(
  board: Awaited<ReturnType<typeof seedBoard>>,
  opts: { first: string; last: string; rn?: boolean; spanishScore?: number; withdrawn?: boolean },
) {
  const applicant = await prisma.applicant.create({
    data: {
      cycleId: board.cycle.id,
      firstName: opts.first,
      lastName: opts.last,
      email: `${opts.first}@example.com`,
      emailLower: `${opts.first}@example.com`.toLowerCase(),
    },
  });
  const application = await prisma.application.create({
    data: {
      cycleId: board.cycle.id,
      applicantId: applicant.id,
      answers: {},
      departmentChoices: ["RHD"],
      ...(opts.withdrawn ? { status: "WITHDRAWN" as const } : {}),
    },
  });
  if (opts.spanishScore !== undefined) {
    await prisma.applicationLanguageAssessment.create({
      data: { applicationId: application.id, language: "es", verified: true, verifiedById: board.approver.id, score: opts.spanishScore },
    });
  }
  const acceptance = await prisma.acceptance.create({
    data: { applicationId: application.id, departmentCode: "RHD", approvedById: board.approver.id },
  });
  if (opts.rn !== undefined) {
    await prisma.onboardingContract.create({
      data: {
        acceptanceId: acceptance.id, token: `t-${Math.random()}`, status: "SUBMITTED",
        firstName: opts.first, lastName: opts.last, email: `${opts.first}@example.com`,
        agreementSignature: "x", professionalismSignature: "x", trainingSignature: "x", initials: "x",
        licensedRN: opts.rn, submittedAt: new Date(),
      },
    });
  }
  return acceptance;
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("loadScheduleExportRows", () => {
  it("lists members and first-timers with their role, RN and Spanish score, sorted by date then role", async () => {
    const board = await seedBoard();
    const { term, rhd } = board;

    const nurse = await prisma.person.create({
      data: { name: "Bea Zhou", legalFirstName: "Bea", lastName: "Zhou", status: "ACTIVE", licensedRN: true },
    });
    await prisma.personLanguage.create({
      data: { personId: nurse.id, language: "es", verified: true, verifiedAt: new Date(), score: 4.5 },
    });
    const director = await prisma.person.create({
      data: { name: "Cal Young", legalFirstName: "Cal", lastName: "Young", status: "ACTIVE" },
    });
    await prisma.shiftAssignment.createMany({
      data: [
        { termId: term.id, departmentId: rhd.id, personId: nurse.id, clinicDate: SEP_5, role: "VOLUNTEER", triage: true, walkin: true },
        { termId: term.id, departmentId: rhd.id, personId: director.id, clinicDate: SEP_5, role: "DIRECTOR" },
        { termId: term.id, departmentId: rhd.id, personId: director.id, clinicDate: SEP_12, role: "DIRECTOR" },
      ],
    });

    const newbie = await seedFirstTimer(board, { first: "Ana", last: "Abad", rn: true, spanishScore: 3 });
    const noContract = await seedFirstTimer(board, { first: "Dev", last: "Nair" });
    await prisma.incomingShiftAssignment.createMany({
      data: [
        { acceptanceId: newbie.id, termId: term.id, departmentId: rhd.id, clinicDate: SEP_5, role: "SHADOW" },
        { acceptanceId: noContract.id, termId: term.id, departmentId: rhd.id, clinicDate: SEP_12, role: "VOLUNTEER" },
      ],
    });

    const rows = await loadScheduleExportRows(term.id, rhd.id);
    expect(
      rows.map((r) => [r.clinicDate.toISOString().slice(0, 10), r.name, r.role, tagsLabel(r.tags), r.licensedRN, r.spanishScore, newcomerLabel(r.newcomer)]),
    ).toEqual([
      ["2026-09-05", "Cal Young", "DIRECTOR", "", false, null, ""],
      ["2026-09-05", "Bea Zhou", "VOLUNTEER", "Triage, Walk-in", true, 4.5, ""],
      ["2026-09-05", "Ana Abad", "SHADOW", "", true, 3, "New"],
      ["2026-09-12", "Cal Young", "DIRECTOR", "", false, null, ""],
      ["2026-09-12", "Dev Nair", "VOLUNTEER", "", false, null, "New"],
    ]);
  });

  it("leaves out other departments and withdrawn first-timers", async () => {
    const board = await seedBoard();
    const { term, rhd, other } = board;
    const elsewhere = await prisma.person.create({ data: { name: "Eli Park", status: "ACTIVE" } });
    await prisma.shiftAssignment.create({
      data: { termId: term.id, departmentId: other.id, personId: elsewhere.id, clinicDate: SEP_5, role: "VOLUNTEER" },
    });
    const gone = await seedFirstTimer(board, { first: "Fay", last: "Ortiz", withdrawn: true });
    await prisma.incomingShiftAssignment.create({
      data: { acceptanceId: gone.id, termId: term.id, departmentId: rhd.id, clinicDate: SEP_5, role: "VOLUNTEER" },
    });

    expect(await loadScheduleExportRows(term.id, rhd.id)).toEqual([]);
  });

  // Roster build turns a first-timer's drafts into ordinary shifts, and that is
  // when directors schedule the term. The first export of a real board (SCTS,
  // FA26) marked nobody new although 7 of its 19 people came in that way.
  it("still marks someone new or a transfer after roster build has promoted them", async () => {
    const board = await seedBoard();
    const { term, rhd, approver, cycle } = board;
    const promoted = async (name: string, applicantType: "NEW" | "RENEWAL" | "TRANSFER", transferFromDepartments: string[] = []) => {
      const [first, last] = name.split(" ");
      const person = await prisma.person.create({ data: { name, legalFirstName: first, lastName: last, status: "ACTIVE" } });
      const applicant = await prisma.applicant.create({
        data: { cycleId: cycle.id, firstName: first, lastName: last, email: `${first}@example.com`, emailLower: `${first}@example.com`.toLowerCase() },
      });
      const application = await prisma.application.create({
        data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, departmentChoices: ["RHD"], applicantType, transferFromDepartments },
      });
      const acceptance = await prisma.acceptance.create({
        data: { applicationId: application.id, departmentCode: "RHD", approvedById: approver.id },
      });
      await prisma.onboardingContract.create({
        data: {
          acceptanceId: acceptance.id, token: `t-${acceptance.id}`, status: "PROMOTED", promotedPersonId: person.id,
          promotedAt: new Date(), firstName: first, lastName: last, email: `${first}@example.com`,
        },
      });
      await prisma.shiftAssignment.create({
        data: { termId: term.id, departmentId: rhd.id, personId: person.id, clinicDate: SEP_5, role: "VOLUNTEER" },
      });
    };
    await promoted("Hana Ito", "NEW");
    await promoted("Ivo Kerr", "TRANSFER", ["PATS"]);
    await promoted("Jo Lin", "RENEWAL");

    const rows = await loadScheduleExportRows(term.id, rhd.id);
    expect(rows.map((r) => [r.name, newcomerLabel(r.newcomer)])).toEqual([
      ["Hana Ito", "New"],
      ["Ivo Kerr", "Transfer from PATS"],
      ["Jo Lin", ""],
    ]);
  });

  // The export reports the number; a "no" verdict still has one.
  it("shows an assessed score even when the verdict was no", async () => {
    const { term, rhd } = await seedBoard();
    const person = await prisma.person.create({ data: { name: "Gus Hale", status: "ACTIVE" } });
    await prisma.personLanguage.create({
      data: { personId: person.id, language: "es", verified: false, verifiedAt: new Date(), score: 2 },
    });
    await prisma.shiftAssignment.create({
      data: { termId: term.id, departmentId: rhd.id, personId: person.id, clinicDate: SEP_5, role: "VOLUNTEER" },
    });

    const [row] = await loadScheduleExportRows(term.id, rhd.id);
    expect(row.spanishScore).toBe(2);
  });
});

describe("buildScheduleWorkbook", () => {
  it("writes a header and one row per shift, with the date as a real date cell", async () => {
    const buffer = await buildScheduleWorkbook([
      {
        clinicDate: SEP_5, name: "Bea Zhou", legalFirstName: "Bea", lastName: "Zhou", role: "VOLUNTEER",
        tags: { triage: true, walkin: false, cc: false, remote: false, specialty: false },
        licensedRN: true, spanishScore: 4.5, newcomer: { type: "TRANSFER", transferFrom: ["PCAR"] },
      },
    ]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Schedule")!;
    expect(ws.getRow(1).values).toEqual([undefined, "Date", "Name", "Role", "Tags", "RN", "Spanish score", "New this term"]);
    const row = ws.getRow(2);
    expect((row.getCell(1).value as Date).toISOString().slice(0, 10)).toBe("2026-09-05");
    expect([2, 3, 4, 5, 6, 7].map((c) => row.getCell(c).value)).toEqual(
      ["Bea Zhou", "Volunteer", "Triage", "Yes", 4.5, "Transfer from PCAR"],
    );
  });

  it("names the file after the department and term", () => {
    expect(scheduleExportFilename("RHD", "FA26")).toBe("RHD schedule FA26.xlsx");
  });
});
