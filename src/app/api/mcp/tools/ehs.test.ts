import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { EHS_RECORDING_NOTE, outstandingEhsClause } from "./ehs";

beforeEach(resetDb);

async function member() {
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-09-01"), endDate: new Date("2026-12-15"), status: "ACTIVE" },
  });
  const dept = await prisma.department.create({ data: { code: "LAB", name: "Lab" } });
  const person = await prisma.person.create({ data: { name: "Lee Lab" } });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  return person;
}

describe("outstandingEhsClause", () => {
  it("names each unrecorded training, links the self-serve ones, and explains the recording lag", async () => {
    const person = await member();
    await prisma.ehsTraining.create({
      data: { name: "Chemical Safety", requiredForAll: true, position: 1, completionUrl: "https://www.myworkday.com/yale/learning" },
    });
    await prisma.ehsTraining.create({ data: { name: "TB Screening", requiredForAll: true, position: 2, completionUrl: null } });

    const text = await outstandingEhsClause(person.id);

    expect(text).toBe(
      `EHS training not yet recorded: Chemical Safety (complete it at https://www.myworkday.com/yale/learning), TB Screening. ${EHS_RECORDING_NOTE}`
    );
  });

  it("returns null once every required training is recorded", async () => {
    const person = await member();
    const training = await prisma.ehsTraining.create({ data: { name: "Chemical Safety", requiredForAll: true, position: 1 } });
    await prisma.ehsCompletion.create({
      data: { personId: person.id, trainingId: training.id, source: "MANUAL", completedAt: new Date("2026-09-10") },
    });

    expect(await outstandingEhsClause(person.id)).toBeNull();
  });

  it("returns null for someone with no roster membership, rather than listing trainings that do not apply", async () => {
    await prisma.term.create({
      data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-09-01"), endDate: new Date("2026-12-15"), status: "ACTIVE" },
    });
    await prisma.ehsTraining.create({ data: { name: "Chemical Safety", requiredForAll: true, position: 1 } });
    const outsider = await prisma.person.create({ data: { name: "No Roster" } });

    expect(await outstandingEhsClause(outsider.id)).toBeNull();
  });
});
