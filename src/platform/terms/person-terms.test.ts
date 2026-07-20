import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getPersonTerms } from "./person-terms";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function seed() {
  const live = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE" } });
  const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING" } });
  const old = await prisma.term.create({ data: { code: "SP26", name: "Spring", startDate: new Date("2026-01-01"), endDate: new Date("2026-05-01"), status: "ARCHIVED" } });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const person = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
  return { live, next, old, dept, person };
}

it("returns live + next where the person is an active member, live first", async () => {
  const { live, next, dept, person } = await seed();
  await prisma.termMembership.create({ data: { personId: person.id, termId: live.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: person.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  const terms = await getPersonTerms(person.id);
  expect(terms.map((t) => t.code)).toEqual(["SU26", "FA26"]);
});

it("excludes ARCHIVED terms and terms the person is not an active member of", async () => {
  const { live, old, dept, person } = await seed();
  await prisma.termMembership.create({ data: { personId: person.id, termId: old.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  // REMOVED membership in the live term must not count.
  await prisma.termMembership.create({ data: { personId: person.id, termId: live.id, departmentId: dept.id, kind: "VOLUNTEER", status: "REMOVED" } });
  expect(await getPersonTerms(person.id)).toEqual([]);
});

it("returns only the next term for a next-term-only recruit", async () => {
  const { next, dept, person } = await seed();
  await prisma.termMembership.create({ data: { personId: person.id, termId: next.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  const terms = await getPersonTerms(person.id);
  expect(terms.map((t) => t.code)).toEqual(["FA26"]);
});
