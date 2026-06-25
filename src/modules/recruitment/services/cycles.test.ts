import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import {
  createCycle, publishCycle, closeCycle, listCycles, CyclePublishError, setCycleDepartments,
} from "./cycles";

async function seedTermAndPerson() {
  const person = await prisma.person.create({ data: { name: "Lead", status: "ACTIVE" } });
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-09-01"), endDate: new Date("2026-12-15") },
  });
  return { person, term };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

describe("createCycle", () => {
  it("creates a DRAFT cycle with a unique slug and seeded identity fields", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "VOLUNTEER", termId: term.id, title: "Volunteer SU26",
      publicSlug: "volunteer-su26", departments: ["SRHD", "MDIC"], acceptsRenewals: false,
      createdById: person.id,
    });
    expect(cycle.status).toBe("DRAFT");
    const fields = await prisma.formField.findMany({ where: { cycleId: cycle.id } });
    expect(fields.map((f) => f.key).sort()).toEqual(["email", "first_name", "last_name"]);
  });
});

describe("publishCycle", () => {
  it("moves DRAFT to OPEN when identity fields exist and there are no dept supplements", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v1",
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    const published = await publishCycle(cycle.id, person.id);
    expect(published.status).toBe("OPEN");
  });

  it("rejects publishing when a dept supplement exists but no DEPARTMENT_CHOICE field", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v2",
      departments: ["SRHD"], acceptsRenewals: false, createdById: person.id,
    });
    await prisma.formSection.create({
      data: { cycleId: cycle.id, title: "SRHD Supplement", order: 1, departmentCode: "SRHD", appliesTo: "NEW" },
    });
    await expect(publishCycle(cycle.id, person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("publishes a renewals cycle whose identity section is visible to both applicant types", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "v3",
      departments: [], acceptsRenewals: true, createdById: person.id,
    });
    const published = await publishCycle(cycle.id, person.id);
    expect(published.status).toBe("OPEN");
  });
});

describe("closeCycle / listCycles", () => {
  it("closes an open cycle and lists it", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "d1",
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    await publishCycle(cycle.id, person.id);
    const closed = await closeCycle(cycle.id, person.id);
    expect(closed.status).toBe("CLOSED");
    const all = await listCycles();
    expect(all.find((c) => c.id === cycle.id)?.status).toBe("CLOSED");
  });
});

describe("setCycleDepartments", () => {
  async function makeCycle(departments: string[]) {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: `v-${departments.join("-").toLowerCase() || "none"}`,
      departments, acceptsRenewals: false, createdById: person.id,
    });
    return { person, cycle };
  }

  it("adds a department and records the new list", async () => {
    const { person, cycle } = await makeCycle(["SRHD"]);
    const { cycle: updated, removedWithApplicants } = await setCycleDepartments(cycle.id, ["SRHD", "MDIC"], person.id);
    expect(updated.departments).toEqual(["SRHD", "MDIC"]);
    expect(removedWithApplicants).toEqual([]);
  });

  it("removes a department with no applicants without warning", async () => {
    const { person, cycle } = await makeCycle(["SRHD", "MDIC"]);
    const { cycle: updated, removedWithApplicants } = await setCycleDepartments(cycle.id, ["SRHD"], person.id);
    expect(updated.departments).toEqual(["SRHD"]);
    expect(removedWithApplicants).toEqual([]);
  });

  it("removes a department that has applicants, saving but reporting the impact", async () => {
    const { person, cycle } = await makeCycle(["SRHD", "MDIC"]);
    const applicant = await prisma.applicant.create({ data: { cycleId: cycle.id, firstName: "A", lastName: "A", email: "a@yale.edu", emailLower: "a@yale.edu" } });
    await prisma.application.create({ data: { cycleId: cycle.id, applicantId: applicant.id, answers: {}, applicantType: "NEW", departmentChoices: ["MDIC"] } });
    const { cycle: updated, removedWithApplicants } = await setCycleDepartments(cycle.id, ["SRHD"], person.id);
    expect(updated.departments).toEqual(["SRHD"]);
    expect(removedWithApplicants).toEqual([{ code: "MDIC", applicantCount: 1 }]);
  });

  it("trims and dedupes the input", async () => {
    const { person, cycle } = await makeCycle(["SRHD"]);
    const { cycle: updated } = await setCycleDepartments(cycle.id, [" SRHD ", "SRHD", "MDIC", ""], person.id);
    expect(updated.departments).toEqual(["SRHD", "MDIC"]);
  });

  it("rejects a missing cycle", async () => {
    const { person } = await seedTermAndPerson();
    await expect(setCycleDepartments("missing", ["SRHD"], person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("rejects an archived cycle", async () => {
    const { person, cycle } = await makeCycle(["SRHD"]);
    await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "ARCHIVED" } });
    await expect(setCycleDepartments(cycle.id, ["SRHD", "MDIC"], person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("records an audit entry with before and after departments", async () => {
    const { person, cycle } = await makeCycle(["SRHD"]);
    await setCycleDepartments(cycle.id, ["SRHD", "MDIC"], person.id);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: cycle.id, action: "recruitment.cycle_set_departments" } });
    expect(audit).not.toBeNull();
    expect((audit!.before as { departments: string[] }).departments).toEqual(["SRHD"]);
    expect((audit!.after as { departments: string[] }).departments).toEqual(["SRHD", "MDIC"]);
  });
});
