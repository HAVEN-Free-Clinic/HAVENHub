import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import {
  createCycle, publishCycle, closeCycle, listCycles, listArchivedCycles, CyclePublishError, setCycleDepartments, setApplicationWindow, reopenCycle, archiveCycle,
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

describe("listArchivedCycles", () => {
  async function makeClosed(termId: string, personId: string, slug: string) {
    const cycle = await createCycle({
      track: "DIRECTOR", termId, title: slug, publicSlug: slug,
      departments: [], acceptsRenewals: false, createdById: personId,
    });
    await publishCycle(cycle.id, personId);
    await closeCycle(cycle.id, personId);
    return cycle;
  }

  it("returns only archived cycles and excludes active (non-archived) ones", async () => {
    const { person, term } = await seedTermAndPerson();
    const active = await makeClosed(term.id, person.id, "arch-active");
    const a1 = await makeClosed(term.id, person.id, "arch-one");
    await archiveCycle(a1.id, person.id);
    const a2 = await makeClosed(term.id, person.id, "arch-two");
    await archiveCycle(a2.id, person.id);

    const archived = await listArchivedCycles();
    expect(archived.map((c) => c.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(archived.every((c) => c.status === "ARCHIVED")).toBe(true);
    expect(archived.some((c) => c.id === active.id)).toBe(false);
  });

  it("returns an empty array when nothing is archived", async () => {
    const { person, term } = await seedTermAndPerson();
    await makeClosed(term.id, person.id, "arch-none");
    expect(await listArchivedCycles()).toEqual([]);
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

describe("setApplicationWindow", () => {
  async function draftCycle(slug: string) {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: slug,
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    return { person, cycle };
  }

  it("sets the open and close dates on a draft cycle", async () => {
    const { person, cycle } = await draftCycle("win-draft");
    const opensAt = new Date("2026-07-01T13:00:00.000Z");
    const closesAt = new Date("2026-07-15T13:00:00.000Z");
    const updated = await setApplicationWindow(cycle.id, { opensAt, closesAt }, person.id);
    expect(updated.opensAt?.getTime()).toBe(opensAt.getTime());
    expect(updated.closesAt?.getTime()).toBe(closesAt.getTime());
  });

  it("sets the window on an open cycle and clears it back to null", async () => {
    const { person, cycle } = await draftCycle("win-open");
    await publishCycle(cycle.id, person.id);
    await setApplicationWindow(cycle.id, { opensAt: new Date("2026-07-01T13:00:00.000Z"), closesAt: new Date("2026-07-15T13:00:00.000Z") }, person.id);
    const cleared = await setApplicationWindow(cycle.id, { opensAt: null, closesAt: null }, person.id);
    expect(cleared.opensAt).toBeNull();
    expect(cleared.closesAt).toBeNull();
  });

  it("rejects an open date later than the close date", async () => {
    const { person, cycle } = await draftCycle("win-inverted");
    await expect(
      setApplicationWindow(cycle.id, { opensAt: new Date("2026-07-15T13:00:00.000Z"), closesAt: new Date("2026-07-01T13:00:00.000Z") }, person.id),
    ).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("rejects a missing cycle", async () => {
    const { person } = await seedTermAndPerson();
    await expect(setApplicationWindow("missing", { opensAt: null, closesAt: null }, person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("rejects setting a window on a closed cycle", async () => {
    const { person, cycle } = await draftCycle("win-closed");
    await publishCycle(cycle.id, person.id);
    await closeCycle(cycle.id, person.id);
    await expect(setApplicationWindow(cycle.id, { opensAt: null, closesAt: null }, person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("records an audit entry with the before and after window", async () => {
    const { person, cycle } = await draftCycle("win-audit");
    const closesAt = new Date("2026-07-15T13:00:00.000Z");
    await setApplicationWindow(cycle.id, { opensAt: null, closesAt }, person.id);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: cycle.id, action: "recruitment.cycle_set_window" } });
    expect(audit).not.toBeNull();
    expect((audit!.after as { closesAt: string | null }).closesAt).toBe(closesAt.toISOString());
  });
});

describe("reopenCycle", () => {
  async function closedCycle(slug: string, overrides: { opensAt?: Date | null; closesAt?: Date | null } = {}) {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "DIRECTOR", termId: term.id, title: "R", publicSlug: slug,
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    await publishCycle(cycle.id, person.id);
    await closeCycle(cycle.id, person.id);
    if (Object.keys(overrides).length > 0) {
      await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: overrides });
    }
    return { person, cycle };
  }

  it("reopens a CLOSED cycle back to OPEN", async () => {
    const { person, cycle } = await closedCycle("reopen-basic");
    const reopened = await reopenCycle(cycle.id, person.id);
    expect(reopened.status).toBe("OPEN");
  });

  it("writes a recruitment.cycle_reopen audit entry", async () => {
    const { person, cycle } = await closedCycle("reopen-audit");
    await reopenCycle(cycle.id, person.id);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: cycle.id, action: "recruitment.cycle_reopen" } });
    expect(audit).not.toBeNull();
  });

  it("records the cleared closesAt in the reopen audit before/after", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { person, cycle } = await closedCycle("reopen-audit-payload", { closesAt: past });
    await reopenCycle(cycle.id, person.id);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: cycle.id, action: "recruitment.cycle_reopen" } });
    expect((audit!.before as { closesAt: string | null }).closesAt).toBe(past.toISOString());
    expect((audit!.after as { closesAt: string | null }).closesAt).toBeNull();
  });

  it("clears a closesAt that is already in the past on reopen", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { person, cycle } = await closedCycle("reopen-stale", { closesAt: past });
    const reopened = await reopenCycle(cycle.id, person.id);
    expect(reopened.status).toBe("OPEN");
    expect(reopened.closesAt).toBeNull();
  });

  it("leaves a future closesAt untouched on reopen", async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const { person, cycle } = await closedCycle("reopen-future", { closesAt: future });
    const reopened = await reopenCycle(cycle.id, person.id);
    expect(reopened.closesAt?.getTime()).toBe(future.getTime());
  });

  it("leaves opensAt untouched on reopen", async () => {
    const opens = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { person, cycle } = await closedCycle("reopen-opens", { opensAt: opens });
    const reopened = await reopenCycle(cycle.id, person.id);
    expect(reopened.opensAt?.getTime()).toBe(opens.getTime());
  });

  it("rejects reopening a DRAFT cycle", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "reopen-draft",
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    await expect(reopenCycle(cycle.id, person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("rejects reopening an OPEN cycle", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "DIRECTOR", termId: term.id, title: "O", publicSlug: "reopen-open",
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    await publishCycle(cycle.id, person.id);
    await expect(reopenCycle(cycle.id, person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("rejects reopening an ARCHIVED cycle (terminal state)", async () => {
    const { person, cycle } = await closedCycle("reopen-archived");
    await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { status: "ARCHIVED" } });
    await expect(reopenCycle(cycle.id, person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("rejects a missing cycle", async () => {
    const { person } = await seedTermAndPerson();
    await expect(reopenCycle("missing", person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });
});

describe("archiveCycle", () => {
  async function closedCycle(slug: string) {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "DIRECTOR", termId: term.id, title: "A", publicSlug: slug,
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    await publishCycle(cycle.id, person.id);
    await closeCycle(cycle.id, person.id);
    return { person, cycle };
  }

  it("archives a CLOSED cycle", async () => {
    const { person, cycle } = await closedCycle("archive-basic");
    const archived = await archiveCycle(cycle.id, person.id);
    expect(archived.status).toBe("ARCHIVED");
  });

  it("writes a recruitment.cycle_archive audit entry", async () => {
    const { person, cycle } = await closedCycle("archive-audit");
    await archiveCycle(cycle.id, person.id);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: cycle.id, action: "recruitment.cycle_archive" } });
    expect(audit).not.toBeNull();
  });

  it("drops the archived cycle out of listCycles", async () => {
    const { person, cycle } = await closedCycle("archive-listed");
    await archiveCycle(cycle.id, person.id);
    const all = await listCycles();
    expect(all.find((c) => c.id === cycle.id)).toBeUndefined();
  });

  it("rejects archiving a DRAFT cycle", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "DIRECTOR", termId: term.id, title: "D", publicSlug: "archive-draft",
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    await expect(archiveCycle(cycle.id, person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("rejects archiving an OPEN cycle", async () => {
    const { person, term } = await seedTermAndPerson();
    const cycle = await createCycle({
      track: "DIRECTOR", termId: term.id, title: "O", publicSlug: "archive-open",
      departments: [], acceptsRenewals: false, createdById: person.id,
    });
    await publishCycle(cycle.id, person.id);
    await expect(archiveCycle(cycle.id, person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("rejects archiving an already-ARCHIVED cycle (terminal state)", async () => {
    const { person, cycle } = await closedCycle("archive-archived");
    await archiveCycle(cycle.id, person.id);
    await expect(archiveCycle(cycle.id, person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });

  it("rejects a missing cycle", async () => {
    const { person } = await seedTermAndPerson();
    await expect(archiveCycle("missing", person.id)).rejects.toBeInstanceOf(CyclePublishError);
  });
});
