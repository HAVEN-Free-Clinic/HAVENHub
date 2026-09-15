import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { getAccessTerm } from "./access-term";

beforeEach(resetDb);

async function seed() {
  const live = await prisma.term.create({
    data: { code: "SU26", name: "Summer 2026", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE" },
  });
  const next = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: new Date("2026-10-03"), endDate: new Date("2027-01-01"), status: "PLANNING" },
  });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const person = await prisma.person.create({ data: { name: "Nova Member", status: "ACTIVE" } });
  const join = (termId: string, status: "ACTIVE" | "REMOVED" = "ACTIVE") =>
    prisma.termMembership.create({ data: { personId: person.id, termId, departmentId: dept.id, kind: "VOLUNTEER", status } });
  return { live, next, person, join };
}

describe("getAccessTerm", () => {
  it("is the live term for someone on its roster, even when they are on the next one too", async () => {
    const { live, next, person, join } = await seed();
    await join(live.id);
    await join(next.id);
    expect((await getAccessTerm(person.id))?.id).toBe(live.id);
  });

  it("is the next term for a new member on that roster but not the live one", async () => {
    const { next, person, join } = await seed();
    await join(next.id);
    expect((await getAccessTerm(person.id))?.id).toBe(next.id);
  });

  it("is the live term for someone on neither roster", async () => {
    const { live, person } = await seed();
    expect((await getAccessTerm(person.id))?.id).toBe(live.id);
  });

  it("ignores a removed next-term membership", async () => {
    const { live, next, person, join } = await seed();
    await join(next.id, "REMOVED");
    expect((await getAccessTerm(person.id))?.id).toBe(live.id);
  });
});
