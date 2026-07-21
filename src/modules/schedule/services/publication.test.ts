import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { publishSchedule, unpublishSchedule, publishedDepartmentIds, isPublished, PublicationError } from "./publication";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function seed() {
  const live = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE" } });
  const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING" } });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  // director with an active-term directorship in dept -> manageableScheduleDepartmentIds includes it
  const dir = await prisma.person.create({ data: { name: "Dir", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: dir.id, termId: live.id, departmentId: dept.id, kind: "DIRECTOR", status: "ACTIVE" } });
  const outsider = await prisma.person.create({ data: { name: "Out", status: "ACTIVE" } });
  return { live, next, dept, dir, outsider };
}

it("publish creates a row, unpublish deletes it; isPublished + publishedDepartmentIds reflect it", async () => {
  const { next, dept, dir } = await seed();
  expect(await isPublished(next.id, dept.id)).toBe(false);
  await publishSchedule(dir.id, { termId: next.id, departmentId: dept.id });
  expect(await isPublished(next.id, dept.id)).toBe(true);
  expect([...(await publishedDepartmentIds(next.id))]).toEqual([dept.id]);
  await unpublishSchedule(dir.id, { termId: next.id, departmentId: dept.id });
  expect(await isPublished(next.id, dept.id)).toBe(false);
  expect(await prisma.schedulePublication.count()).toBe(0);
});

it("publish is idempotent (re-publish keeps a single row)", async () => {
  const { next, dept, dir } = await seed();
  await publishSchedule(dir.id, { termId: next.id, departmentId: dept.id });
  await publishSchedule(dir.id, { termId: next.id, departmentId: dept.id });
  expect(await prisma.schedulePublication.count()).toBe(1);
});

it("rejects publishing the live (ACTIVE) term and an ARCHIVED term", async () => {
  const { live, dept, dir } = await seed();
  const archived = await prisma.term.create({ data: { code: "SP26", name: "Spring", startDate: new Date("2026-01-01"), endDate: new Date("2026-05-01"), status: "ARCHIVED" } });
  await expect(publishSchedule(dir.id, { termId: live.id, departmentId: dept.id })).rejects.toBeInstanceOf(PublicationError);
  await expect(publishSchedule(dir.id, { termId: archived.id, departmentId: dept.id })).rejects.toBeInstanceOf(PublicationError);
});

it("rejects a publisher who does not manage the department", async () => {
  const { next, dept, outsider } = await seed();
  await expect(publishSchedule(outsider.id, { termId: next.id, departmentId: dept.id })).rejects.toBeInstanceOf(PublicationError);
});
