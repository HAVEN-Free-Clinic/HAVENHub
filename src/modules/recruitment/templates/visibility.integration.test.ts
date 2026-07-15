// visibility.integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { createCycle } from "../services/cycles";
import { isSectionVisible } from "../engine/visibility";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function seed() {
  const person = await prisma.person.create({ data: { name: "L", status: "ACTIVE" } });
  const term = await prisma.term.create({ data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-09-01"), endDate: new Date("2026-12-15") } });
  return { person, term };
}

describe("default template + visibility engine", () => {
  it("hides the NEW-only personal-details section for a renewal, shows it for a new applicant", async () => {
    const { person, term } = await seed();
    const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "vis-1", departments: ["MDIC"], acceptsRenewals: true, createdById: person.id }, true);
    const sections = await prisma.formSection.findMany({ where: { cycleId: cycle.id } });
    const personal = sections.find((s) => s.title === "Personal details")!;
    expect(isSectionVisible(personal, { applicantType: "RENEWAL", selectedDepartmentCodes: [] })).toBe(false);
    expect(isSectionVisible(personal, { applicantType: "NEW", selectedDepartmentCodes: [] })).toBe(true);
  });

  it("hides a department supplement unless that department is chosen", async () => {
    const { person, term } = await seed();
    const cycle = await createCycle({ track: "VOLUNTEER", termId: term.id, title: "V", publicSlug: "vis-2", departments: ["MDIC"], acceptsRenewals: false, createdById: person.id }, true);
    const supp = (await prisma.formSection.findMany({ where: { cycleId: cycle.id } })).find((s) => s.departmentCode === "MDIC")!;
    expect(isSectionVisible(supp, { applicantType: "NEW", selectedDepartmentCodes: [] })).toBe(false);
    expect(isSectionVisible(supp, { applicantType: "NEW", selectedDepartmentCodes: ["MDIC"] })).toBe(true);
  });
});
