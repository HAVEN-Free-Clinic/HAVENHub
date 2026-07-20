import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getNextTerm } from "./next-term";

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("returns null when there is no PLANNING term", async () => {
  await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE" } });
  expect(await getNextTerm()).toBeNull();
});

it("returns the single PLANNING term (newest by startDate)", async () => {
  await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date("2026-05-30"), endDate: new Date("2026-09-26"), status: "ACTIVE" } });
  const fa = await prisma.term.create({ data: { code: "FA26", name: "Fall", startDate: new Date("2026-09-01"), endDate: new Date("2027-01-01"), status: "PLANNING" } });
  expect((await getNextTerm())?.id).toBe(fa.id);
});
