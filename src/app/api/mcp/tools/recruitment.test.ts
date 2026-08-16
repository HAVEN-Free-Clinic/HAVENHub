import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { assertSafeToolOutput, collectSchemaKeys, FORBIDDEN_OUTPUT_PATTERN, IDENTITY_ARGUMENT_PATTERN } from "./index";
import { recruitmentCycleStatusTool, myApplicationStatusTool } from "./recruitment";

/**
 * Real-DB tests, like roster.test.ts and unlike compliance/training.test.ts:
 * the risk here lives in Prisma queries (recruitment.manage_cycles gating,
 * the SUBMITTED-only count, getApplicantStatus's personId/email matching),
 * not in a service this file could safely mock away.
 */

async function activeTerm(code = "FA26") {
  return prisma.term.create({
    data: { code, name: "Fall 2026", startDate: new Date("2026-08-01"), endDate: new Date("2026-12-01"), status: "ACTIVE" },
  });
}

function createPerson(name: string, opts?: { contactEmail?: string }) {
  return prisma.person.create({ data: { name, contactEmail: opts?.contactEmail } });
}

async function grantManageCycles(personId: string) {
  const role = await prisma.role.create({
    data: { name: `Cycle Manager ${personId}`, grants: { create: [{ permission: "recruitment.manage_cycles" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId, roleId: role.id } });
}

/** A department director in the active term -- reviewScope-shaped access,
 *  deliberately WITHOUT recruitment.manage_cycles, to prove cycle status does
 *  not leak in through directorship the way it must not (see the file-level
 *  comment in recruitment.ts on why this is not reviewScope-gated). */
async function makeDirector(termId: string) {
  const dept = await prisma.department.create({ data: { code: `D${Math.random().toString(36).slice(2, 6)}`, name: "Some Dept" } });
  const director = await prisma.person.create({ data: { name: "Some Director" } });
  await prisma.termMembership.create({ data: { personId: director.id, termId, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
  return director;
}

async function makeCycle(opts: {
  slug: string;
  termId: string;
  createdById: string;
  status?: "DRAFT" | "OPEN" | "CLOSED" | "ARCHIVED";
  track?: "VOLUNTEER" | "DIRECTOR";
  opensAt?: Date | null;
  closesAt?: Date | null;
  title?: string;
}) {
  return prisma.recruitmentCycle.create({
    data: {
      track: opts.track ?? "VOLUNTEER",
      termId: opts.termId,
      title: opts.title ?? opts.slug,
      publicSlug: opts.slug,
      departments: ["SRHD"],
      createdById: opts.createdById,
      status: opts.status ?? "OPEN",
      opensAt: opts.opensAt ?? null,
      closesAt: opts.closesAt ?? null,
    },
  });
}

async function makeApplication(
  cycleId: string,
  opts: { email: string; applicantPersonId?: string | null; status?: "DRAFT" | "SUBMITTED" | "WITHDRAWN" }
) {
  const applicant = await prisma.applicant.create({
    data: {
      cycleId,
      firstName: "A",
      lastName: "B",
      email: opts.email,
      emailLower: opts.email.toLowerCase(),
      applicantPersonId: opts.applicantPersonId ?? null,
    },
  });
  const status = opts.status ?? "SUBMITTED";
  return prisma.application.create({
    data: {
      cycleId,
      applicantId: applicant.id,
      answers: {},
      applicantType: "NEW",
      departmentChoices: ["SRHD"],
      status,
      submittedAt: status === "SUBMITTED" ? new Date() : null,
    },
  });
}

beforeEach(resetDb);

describe("recruitment_cycle_status", () => {
  it("denies a caller with no recruitment.manage_cycles permission, even though a cycle is open", async () => {
    const term = await activeTerm();
    const creator = await createPerson("Creator");
    await makeCycle({ slug: "open1", termId: term.id, createdById: creator.id });
    const outsider = await createPerson("Outsider");

    const text = await recruitmentCycleStatusTool.run({ personId: outsider.id }, {});

    expect(text).toMatch(/do not have access/i);
  });

  it("returns byte-identical refusal text whether or not any cycle is actually open", async () => {
    const term = await activeTerm();
    const creator = await createPerson("Creator 2");
    const outsider = await createPerson("Outsider 2");

    const noneOpenText = await recruitmentCycleStatusTool.run({ personId: outsider.id }, {});

    await makeCycle({ slug: "open2", termId: term.id, createdById: creator.id });
    const oneOpenText = await recruitmentCycleStatusTool.run({ personId: outsider.id }, {});

    expect(noneOpenText).toBe(oneOpenText);
  });

  it("denies a department director (reviewScope-shaped access) who lacks recruitment.manage_cycles", async () => {
    const term = await activeTerm();
    const creator = await createPerson("Creator 3");
    await makeCycle({ slug: "open3", termId: term.id, createdById: creator.id });
    const director = await makeDirector(term.id);

    const text = await recruitmentCycleStatusTool.run({ personId: director.id }, {});

    expect(text).toMatch(/do not have access/i);
  });

  it("says there is no recruitment cycle open right now when none is OPEN", async () => {
    const term = await activeTerm();
    const manager = await createPerson("Manager");
    await grantManageCycles(manager.id);
    await makeCycle({ slug: "draft1", termId: term.id, createdById: manager.id, status: "DRAFT" });
    await makeCycle({ slug: "closed1", termId: term.id, createdById: manager.id, status: "CLOSED" });

    const text = await recruitmentCycleStatusTool.run({ personId: manager.id }, {});

    expect(text).toMatch(/no recruitment cycle open/i);
  });

  it("reports true SUBMITTED-only counts and the closing date for a live cycle", async () => {
    const term = await activeTerm();
    const manager = await createPerson("Manager 2");
    await grantManageCycles(manager.id);
    const closesAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    const cycle = await makeCycle({
      slug: "live1", termId: term.id, createdById: manager.id, closesAt, title: "Volunteer Recruitment",
    });
    await makeApplication(cycle.id, { email: "a@yale.edu", status: "SUBMITTED" });
    await makeApplication(cycle.id, { email: "b@yale.edu", status: "SUBMITTED" });
    await makeApplication(cycle.id, { email: "c@yale.edu", status: "DRAFT" }); // must not count
    await makeApplication(cycle.id, { email: "d@yale.edu", status: "WITHDRAWN" }); // must not count

    const text = await recruitmentCycleStatusTool.run({ personId: manager.id }, {});

    expect(text).toContain("Volunteer Recruitment");
    expect(text).toContain("2 applications so far");
    expect(text).toMatch(/is open now/i);
  });

  it("reports a cycle scheduled to open in the future as not yet accepting applications", async () => {
    const term = await activeTerm();
    const manager = await createPerson("Manager 3");
    await grantManageCycles(manager.id);
    const opensAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await makeCycle({ slug: "future1", termId: term.id, createdById: manager.id, opensAt, title: "Not Yet Open" });

    const text = await recruitmentCycleStatusTool.run({ personId: manager.id }, {});

    expect(text).toMatch(/scheduled to open/i);
    expect(text).not.toMatch(/is open now/i);
  });

  it("reports a cycle whose window already closed while status remains OPEN", async () => {
    const term = await activeTerm();
    const manager = await createPerson("Manager 4");
    await grantManageCycles(manager.id);
    const closesAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await makeCycle({ slug: "past1", termId: term.id, createdById: manager.id, closesAt, title: "Already Closed" });

    const text = await recruitmentCycleStatusTool.run({ personId: manager.id }, {});

    expect(text).toMatch(/window closed/i);
    expect(text).not.toMatch(/is open now/i);
  });

  it("bounds the number of cycles reported", async () => {
    const term = await activeTerm();
    const manager = await createPerson("Manager 5");
    await grantManageCycles(manager.id);
    for (let i = 0; i < 6; i++) {
      await makeCycle({ slug: `bound${i}`, termId: term.id, createdById: manager.id, title: `Cycle ${i}` });
    }

    const text = await recruitmentCycleStatusTool.run({ personId: manager.id }, {});

    const mentioned = [0, 1, 2, 3, 4, 5].filter((i) => text.includes(`Cycle ${i}`));
    expect(mentioned.length).toBe(5); // MAX_CYCLES
  });

  it("declares no identity-shaped input", () => {
    for (const key of collectSchemaKeys(recruitmentCycleStatusTool.inputSchema)) {
      expect(IDENTITY_ARGUMENT_PATTERN.test(key)).toBe(false);
    }
    expect(Object.keys(recruitmentCycleStatusTool.inputSchema.shape)).toEqual([]);
  });

  it("never emits a forbidden value", async () => {
    const term = await activeTerm();
    const manager = await createPerson("Manager 6");
    await grantManageCycles(manager.id);
    await makeCycle({ slug: "safe1", termId: term.id, createdById: manager.id });

    const text = await recruitmentCycleStatusTool.run({ personId: manager.id }, {});

    expect(FORBIDDEN_OUTPUT_PATTERN.test(text)).toBe(false);
    expect(() => assertSafeToolOutput(text)).not.toThrow();
  });
});

describe("my_application_status", () => {
  it("says there is no application on file for a caller who never applied", async () => {
    const caller = await createPerson("Never Applied");

    const text = await myApplicationStatusTool.run({ personId: caller.id }, {});

    expect(text).toMatch(/could not find a recruitment application/i);
  });

  it("reports the caller's own submitted application, linked via applicantPersonId", async () => {
    const term = await activeTerm();
    const creator = await createPerson("Creator");
    const caller = await createPerson("Applicant One", { contactEmail: "applicant1@yale.edu" });
    const cycle = await makeCycle({ slug: "my1", termId: term.id, createdById: creator.id, title: "Fall Volunteer Cycle" });
    await makeApplication(cycle.id, { email: "applicant1@yale.edu", applicantPersonId: caller.id });

    const text = await myApplicationStatusTool.run({ personId: caller.id }, {});

    expect(text).toContain("Fall Volunteer Cycle");
    expect(text).toMatch(/submitted/i);
  });

  it("finds an application via the email fallback when applicantPersonId was never linked (a later-promoted anonymous applicant)", async () => {
    const term = await activeTerm();
    const creator = await createPerson("Creator 2");
    const caller = await createPerson("Applicant Two", { contactEmail: "applicant2@yale.edu" });
    const cycle = await makeCycle({ slug: "my2", termId: term.id, createdById: creator.id, title: "Spring Director Cycle" });
    // applicantPersonId intentionally left null -- this is what a true anonymous
    // NEW submission looks like (see submissions.ts). The only link back is email.
    await makeApplication(cycle.id, { email: "applicant2@yale.edu", applicantPersonId: null });

    const text = await myApplicationStatusTool.run({ personId: caller.id }, {});

    expect(text).toContain("Spring Director Cycle");
  });

  it("never reveals another person's application", async () => {
    const term = await activeTerm();
    const creator = await createPerson("Creator 3");
    const caller = await createPerson("Applicant Three", { contactEmail: "applicant3@yale.edu" });
    const other = await createPerson("Applicant Four", { contactEmail: "applicant4@yale.edu" });
    const cycle = await makeCycle({ slug: "my3", termId: term.id, createdById: creator.id, title: "Someone Elses Cycle" });
    await makeApplication(cycle.id, { email: "applicant4@yale.edu", applicantPersonId: other.id });

    const text = await myApplicationStatusTool.run({ personId: caller.id }, {});

    expect(text).not.toContain("Someone Elses Cycle");
    expect(text).toMatch(/could not find a recruitment application/i);
  });

  it("bounds the number of applications reported", async () => {
    const term = await activeTerm();
    const creator = await createPerson("Creator 4");
    const caller = await createPerson("Applicant Five", { contactEmail: "applicant5@yale.edu" });
    for (let i = 0; i < 6; i++) {
      const cycle = await makeCycle({ slug: `mybound${i}`, termId: term.id, createdById: creator.id, title: `My Cycle ${i}` });
      await makeApplication(cycle.id, { email: "applicant5@yale.edu", applicantPersonId: caller.id });
    }

    const text = await myApplicationStatusTool.run({ personId: caller.id }, {});

    const mentioned = [0, 1, 2, 3, 4, 5].filter((i) => text.includes(`My Cycle ${i}`));
    expect(mentioned.length).toBe(5); // MAX_APPLICATIONS
    expect(text).toMatch(/more application/i);
  });

  it("declares no identity-shaped input", () => {
    for (const key of collectSchemaKeys(myApplicationStatusTool.inputSchema)) {
      expect(IDENTITY_ARGUMENT_PATTERN.test(key)).toBe(false);
    }
    expect(Object.keys(myApplicationStatusTool.inputSchema.shape)).toEqual([]);
  });

  it("never emits a forbidden value", async () => {
    const term = await activeTerm();
    const creator = await createPerson("Creator 5");
    const caller = await createPerson("Applicant Six", { contactEmail: "applicant6@yale.edu" });
    const cycle = await makeCycle({ slug: "safe2", termId: term.id, createdById: creator.id });
    await makeApplication(cycle.id, { email: "applicant6@yale.edu", applicantPersonId: caller.id });

    const text = await myApplicationStatusTool.run({ personId: caller.id }, {});

    expect(FORBIDDEN_OUTPUT_PATTERN.test(text)).toBe(false);
    expect(() => assertSafeToolOutput(text)).not.toThrow();
  });
});
