import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import {
  createCycle, publishCycle, closeCycle, listCycles, CyclePublishError,
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

  it("rejects publishing a renewals cycle with no RENEWAL-visible section", async () => {
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
