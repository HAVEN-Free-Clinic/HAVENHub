/**
 * listUpcomingCycles is what puts a DRAFT cycle's title in front of the public,
 * so these tests are mostly about what it must NOT return. A regression that
 * widens the status set or drops the future-date requirement would publish
 * every half-built form in the workspace, and nothing else in the app would
 * complain.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CycleStatus } from "@prisma/client";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { listUpcomingCycles } from "./upcoming-cycles";

const NOW = new Date("2026-09-01T12:00:00Z");
const SOON = new Date("2026-10-01T12:00:00Z");
const LATER = new Date("2026-11-01T12:00:00Z");
const PAST = new Date("2026-08-01T12:00:00Z");

let termId: string;
let createdById: string;

async function seedCycle(
  slug: string,
  status: CycleStatus,
  opensAt: Date | null,
  title = slug
) {
  return prisma.recruitmentCycle.create({
    data: { track: "VOLUNTEER", termId, title, publicSlug: slug, status, opensAt, createdById },
  });
}

beforeEach(async () => {
  await resetDb();
  const term = await prisma.term.create({
    data: { code: "FA26", name: "Fall 2026", startDate: NOW, endDate: LATER },
  });
  termId = term.id;
  const person = await prisma.person.create({ data: { name: "Staffer", status: "ACTIVE" } });
  createdById = person.id;
});

afterEach(async () => {
  await resetDb();
});

describe("listUpcomingCycles", () => {
  it("announces a DRAFT cycle that has a future open date -- the case this exists for", async () => {
    await seedCycle("spring-vol", "DRAFT", SOON, "Spring Volunteer Recruitment");
    const upcoming = await listUpcomingCycles(NOW);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]).toMatchObject({
      title: "Spring Volunteer Recruitment",
      publicSlug: "spring-vol",
      opensAt: SOON,
    });
  });

  it("announces an OPEN cycle still ahead of its own window, which is invisible everywhere else", async () => {
    await seedCycle("published-early", "OPEN", SOON);
    expect(await listUpcomingCycles(NOW)).toHaveLength(1);
  });

  it("never announces a DRAFT with no open date -- the date IS the opt-in, so a working title stays internal", async () => {
    await seedCycle("half-built", "DRAFT", null, "TEST DO NOT USE");
    expect(await listUpcomingCycles(NOW)).toEqual([]);
  });

  it("never announces a cycle whose open date has already passed", async () => {
    await seedCycle("already-open", "OPEN", PAST);
    await seedCycle("stale-draft", "DRAFT", PAST);
    expect(await listUpcomingCycles(NOW)).toEqual([]);
  });

  it("never announces CLOSED or ARCHIVED, even with a future date on the row", async () => {
    await seedCycle("closed-future", "CLOSED", SOON);
    await seedCycle("archived-future", "ARCHIVED", SOON);
    expect(await listUpcomingCycles(NOW)).toEqual([]);
  });

  it("orders soonest first, so the next thing to open reads first", async () => {
    await seedCycle("later", "DRAFT", LATER);
    await seedCycle("soon", "OPEN", SOON);
    const upcoming = await listUpcomingCycles(NOW);
    expect(upcoming.map((c) => c.publicSlug)).toEqual(["soon", "later"]);
  });

  it("returns nothing when there is genuinely nothing scheduled", async () => {
    expect(await listUpcomingCycles(NOW)).toEqual([]);
  });
});
