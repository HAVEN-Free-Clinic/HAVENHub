/**
 * Integration tests for the auto-assign service.
 *
 * The engine itself is covered by engine/auto-assign.test.ts, which is pure.
 * These cover the parts only a database can answer: who is schedulable, whose
 * availability is in force, and that applying a proposal goes through the same
 * validation a hand-placed assignment does.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { isoDateKey } from "@/platform/dates";
import { previewAutoAssign, applyAutoAssign } from "./auto-assign";
import { BuilderForbiddenError, provisionalRowId } from "./builder";

beforeEach(resetDb);

function utcNoon(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

/** Six Saturdays at noon UTC. */
function sixSaturdays(): Date[] {
  const base = utcNoon(2026, 5, 30);
  return Array.from({ length: 6 }, (_, i) => new Date(base.getTime() + i * 7 * 86_400_000));
}

async function createPerson(name: string) {
  return prisma.person.create({ data: { name } });
}

async function createTerm(clinicDates: Date[]) {
  return prisma.term.create({
    data: {
      code: `SU26-${Date.now()}-${Math.random()}`,
      name: "Summer 2026",
      startDate: utcNoon(2026, 5, 30),
      endDate: utcNoon(2026, 9, 26),
      status: "ACTIVE",
      clinicDates,
    },
  });
}

async function createDepartment(code: string, opts: { maxVolunteersPerShift?: number } = {}) {
  return prisma.department.upsert({
    where: { code },
    update: {},
    create: {
      code,
      name: `${code} Dept`,
      maxVolunteersPerShift: opts.maxVolunteersPerShift,
    },
  });
}

async function createMembership(
  personId: string,
  termId: string,
  departmentId: string,
  kind: "VOLUNTEER" | "DIRECTOR",
  opts: { baselineAvailability?: Date[] } = {},
) {
  return prisma.termMembership.create({
    data: {
      personId,
      termId,
      departmentId,
      kind,
      status: "ACTIVE",
      baselineAvailability: opts.baselineAvailability ?? [],
    },
  });
}

describe("previewAutoAssign", () => {
  it("fills each clinic date up to the department's cap and no further", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("INTP", { maxVolunteersPerShift: 2 });
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    for (let i = 0; i < 5; i++) {
      const v = await createPerson(`V${i}`);
      await createMembership(v.id, term.id, dept.id, "VOLUNTEER", { baselineAvailability: dates });
    }

    const preview = await previewAutoAssign(director.id, {
      termId: term.id,
      departmentId: dept.id,
    });

    expect(preview.proposal.additions.length).toBeGreaterThan(0);
    for (const dateKey of dates.map(isoDateKey)) {
      const onDate = preview.proposal.additions.filter((a) => a.dateKey === dateKey);
      expect(onDate.length).toBeLessThanOrEqual(2);
    }
  });

  it("never proposes someone on a date their availability does not cover", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("INTP");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    const v = await createPerson("Picky");
    await createMembership(v.id, term.id, dept.id, "VOLUNTEER", {
      baselineAvailability: [dates[0]],
    });

    const preview = await previewAutoAssign(director.id, {
      termId: term.id,
      departmentId: dept.id,
    });

    const mine = preview.proposal.additions.filter((a) => a.memberId === v.id);
    expect(mine).toEqual([{ dateKey: isoDateKey(dates[0]), memberId: v.id }]);
  });
});

describe("applyAutoAssign", () => {
  it("writes the proposed assignments onto the board", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("INTP", { maxVolunteersPerShift: 1 });
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    const v = await createPerson("Volunteer");
    await createMembership(v.id, term.id, dept.id, "VOLUNTEER", { baselineAvailability: dates });

    const preview = await previewAutoAssign(director.id, {
      termId: term.id,
      departmentId: dept.id,
    });
    const result = await applyAutoAssign(director.id, {
      termId: term.id,
      departmentId: dept.id,
      additions: preview.proposal.additions,
    });

    const rows = await prisma.shiftAssignment.count({
      where: { termId: term.id, departmentId: dept.id, role: "VOLUNTEER" },
    });
    expect(result.applied).toBe(preview.proposal.additions.length);
    expect(rows).toBe(preview.proposal.additions.length);
  });
});

describe("previewAutoAssign: scope", () => {
  it("refuses a department the actor does not manage", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("INTP");
    const outsider = await createPerson("Outsider");

    await expect(
      previewAutoAssign(outsider.id, { termId: term.id, departmentId: dept.id }),
    ).rejects.toBeInstanceOf(BuilderForbiddenError);
  });
});

/** An accepted applicant with no Person yet: the first-time-applicant case. */
async function createAcceptedApplicant(opts: {
  termId: string;
  departmentCode: string;
  name: string;
  approvedById: string;
  availability?: string[];
}) {
  const email = `${opts.name.replace(/\s+/g, ".").toLowerCase()}@yale.edu`;
  const cycle = await prisma.recruitmentCycle.create({
    data: {
      track: "VOLUNTEER",
      termId: opts.termId,
      title: `Cycle ${opts.name}`,
      publicSlug: `c-${Date.now()}-${Math.random()}`,
      departments: [opts.departmentCode],
      createdById: opts.approvedById,
      status: "OPEN",
    },
  });
  const applicant = await prisma.applicant.create({
    data: {
      cycleId: cycle.id,
      firstName: opts.name.split(" ")[0],
      lastName: opts.name.split(" ")[1] ?? "",
      email,
      emailLower: email,
    },
  });
  const application = await prisma.application.create({
    data: {
      cycleId: cycle.id,
      applicantId: applicant.id,
      answers: opts.availability ? { availability: opts.availability } : {},
      departmentChoices: [opts.departmentCode],
    },
  });
  const acceptance = await prisma.acceptance.create({
    data: {
      applicationId: application.id,
      departmentCode: opts.departmentCode,
      approvedById: opts.approvedById,
    },
  });
  return { acceptance };
}

describe("previewAutoAssign: the incoming class", () => {
  it("schedules an accepted applicant who has no Person yet", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("INTP");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    const { acceptance } = await createAcceptedApplicant({
      termId: term.id,
      departmentCode: "INTP",
      name: "New Person",
      approvedById: director.id,
      availability: [isoDateKey(dates[0]), isoDateKey(dates[1])],
    });

    const preview = await previewAutoAssign(director.id, {
      termId: term.id,
      departmentId: dept.id,
    });

    const rowId = provisionalRowId(acceptance.id);
    const mine = preview.proposal.additions.filter((a) => a.memberId === rowId);
    expect(mine.map((a) => a.dateKey).sort()).toEqual([
      isoDateKey(dates[0]),
      isoDateKey(dates[1]),
    ]);
  });

  it("applies their shifts to the incoming draft table, not the roster one", async () => {
    const dates = sixSaturdays();
    const term = await createTerm(dates);
    const dept = await createDepartment("INTP");
    const director = await createPerson("Director");
    await createMembership(director.id, term.id, dept.id, "DIRECTOR");

    await createAcceptedApplicant({
      termId: term.id,
      departmentCode: "INTP",
      name: "New Person",
      approvedById: director.id,
      availability: [isoDateKey(dates[0])],
    });

    const preview = await previewAutoAssign(director.id, {
      termId: term.id,
      departmentId: dept.id,
    });
    await applyAutoAssign(director.id, {
      termId: term.id,
      departmentId: dept.id,
      additions: preview.proposal.additions,
    });

    expect(await prisma.incomingShiftAssignment.count({ where: { termId: term.id } })).toBe(1);
    expect(await prisma.shiftAssignment.count({ where: { termId: term.id } })).toBe(0);
  });
});
