import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getWorkingTerm } from "./working-term";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function seed() {
  const live = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE" } });
  const next = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING" } });
  return { live, next };
}

it("returns the live term when no selection is given", async () => {
  const { live } = await seed();
  expect((await getWorkingTerm())?.id).toBe(live.id);
});

it("returns the next term when selected", async () => {
  const { next } = await seed();
  expect((await getWorkingTerm(next.id))?.id).toBe(next.id);
});

it("falls back to the live term for an invalid or archived selection", async () => {
  const { live } = await seed();
  expect((await getWorkingTerm("does-not-exist"))?.id).toBe(live.id);
});

it("resolves an archived term by id (for read-only viewing)", async () => {
  const { live } = await seed();
  const archived = await prisma.term.create({ data: { code: "SP26", name: "Spring", startDate: new Date("2026-01-01"), endDate: new Date("2026-05-01"), status: "ARCHIVED" } });
  expect((await getWorkingTerm(archived.id))?.id).toBe(archived.id);
  // an unknown id still falls back to live
  expect((await getWorkingTerm("nope"))?.id).toBe(live.id);
});
