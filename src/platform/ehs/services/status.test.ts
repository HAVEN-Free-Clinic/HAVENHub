import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { getEhsDashboard } from "./status";
import { createTraining, setTrainingDepartments } from "./trainings";
import { markEhsComplete } from "./completion";

beforeEach(resetDb);
afterEach(resetDb);

async function buildBaseFixtures() {
  const actor = await prisma.person.create({ data: { name: "Admin", status: "ACTIVE" } });
  const term = await prisma.term.create({
    data: {
      code: "SU26",
      name: "Summer 2026",
      startDate: new Date("2026-05-01T00:00:00.000Z"),
      endDate: new Date("2026-08-31T00:00:00.000Z"),
      status: "ACTIVE",
    },
  });
  const dept = await prisma.department.create({ data: { code: "PCAR", name: "Primary Care" } });
  const person = await prisma.person.create({ data: { name: "Volunteer", status: "ACTIVE" } });
  await prisma.termMembership.create({
    data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" },
  });
  return { actor, term, dept, person };
}

describe("getEhsDashboard", () => {
  it("returns active trainings and one row per active-term roster member", async () => {
    const { actor, dept } = await buildBaseFixtures();
    const training = await createTraining({ name: "BBP Clinical", requiredForAll: true }, actor.id);

    const dash = await getEhsDashboard();

    expect(dash.trainings.length).toBeGreaterThanOrEqual(1);
    expect(dash.trainings.some((t) => t.id === training.id)).toBe(true);

    // The one active member should have one row
    expect(dash.rows.length).toBeGreaterThanOrEqual(1);
    const row = dash.rows.find((r) => r.name === "Volunteer");
    expect(row).toBeDefined();
    expect(row!.addedToEhs).toBe(false);
    expect(row!.cells.length).toBe(dash.trainings.length);

    const cell = row!.cells.find((c) => c.trainingId === training.id);
    expect(cell!.state).toBe("MISSING");

    // Suppress unused variable warning
    void dept;
  });

  it("reflects COMPLETE after markEhsComplete", async () => {
    const { actor, person } = await buildBaseFixtures();
    const training = await createTraining({ name: "BBP Clinical", requiredForAll: true }, actor.id);

    await markEhsComplete(person.id, training.id, actor.id, new Date("2026-03-01"));

    const dash = await getEhsDashboard();
    const row = dash.rows.find((r) => r.personId === person.id);
    const cell = row!.cells.find((c) => c.trainingId === training.id);
    expect(cell!.state).toBe("COMPLETE");
  });

  it("shows NA for a training not required for the member's department", async () => {
    const { actor, person } = await buildBaseFixtures();
    // Training scoped to a different department
    const otherDept = await prisma.department.create({ data: { code: "SCTP", name: "Street Care" } });
    const training = await createTraining({ name: "SCTP Only Training", requiredForAll: false }, actor.id);
    await setTrainingDepartments(training.id, [otherDept.id], actor.id);

    const dash = await getEhsDashboard();
    const row = dash.rows.find((r) => r.personId === person.id);
    expect(row).toBeDefined();

    const cell = row!.cells.find((c) => c.trainingId === training.id);
    // Member is in PCAR, training is scoped to SCTP -> NA
    expect(cell!.state).toBe("NA");
  });

  it("shows MISSING for a training scoped to the member's department", async () => {
    const { actor, person, dept } = await buildBaseFixtures();
    const training = await createTraining({ name: "PCAR Training", requiredForAll: false }, actor.id);
    await setTrainingDepartments(training.id, [dept.id], actor.id);

    const dash = await getEhsDashboard();
    const row = dash.rows.find((r) => r.personId === person.id);
    const cell = row!.cells.find((c) => c.trainingId === training.id);
    // Member is in PCAR, training is scoped to PCAR -> MISSING (not yet completed)
    expect(cell!.state).toBe("MISSING");
  });

  it("splits BBP clinical/student by yaleAffiliation student status", async () => {
    const { term, dept } = await buildBaseFixtures();

    // Create the two BBP trainings with the fixed stable seed IDs.
    const bbpClinical = await prisma.ehsTraining.create({
      data: {
        id: "ehs_bbp_clinical",
        name: "BBP Clinical",
        requiredForAll: true,
        isActive: true,
        position: 100,
      },
    });
    const bbpStudent = await prisma.ehsTraining.create({
      data: {
        id: "ehs_bbp_student",
        name: "BBP Student",
        requiredForAll: true,
        isActive: true,
        position: 101,
      },
    });

    // A student (Yale College) and a non-student (Yale Staff), each with an ACTIVE membership.
    const student = await prisma.person.create({
      data: { name: "Student Person", status: "ACTIVE", yaleAffiliation: "Yale College" },
    });
    await prisma.termMembership.create({
      data: {
        personId: student.id,
        termId: term.id,
        departmentId: dept.id,
        kind: "VOLUNTEER",
        status: "ACTIVE",
      },
    });

    const nonStudent = await prisma.person.create({
      data: { name: "Staff Person", status: "ACTIVE", yaleAffiliation: "Yale Staff" },
    });
    await prisma.termMembership.create({
      data: {
        personId: nonStudent.id,
        termId: term.id,
        departmentId: dept.id,
        kind: "VOLUNTEER",
        status: "ACTIVE",
      },
    });

    const dash = await getEhsDashboard();

    const studentRow = dash.rows.find((r) => r.personId === student.id);
    const nonStudentRow = dash.rows.find((r) => r.personId === nonStudent.id);
    expect(studentRow).toBeDefined();
    expect(nonStudentRow).toBeDefined();

    // Student: BBP Clinical = NA, BBP Student = MISSING.
    expect(studentRow!.cells.find((c) => c.trainingId === bbpClinical.id)!.state).toBe("NA");
    expect(studentRow!.cells.find((c) => c.trainingId === bbpStudent.id)!.state).toBe("MISSING");

    // Non-student: BBP Clinical = MISSING, BBP Student = NA.
    expect(nonStudentRow!.cells.find((c) => c.trainingId === bbpClinical.id)!.state).toBe("MISSING");
    expect(nonStudentRow!.cells.find((c) => c.trainingId === bbpStudent.id)!.state).toBe("NA");
  });
});
