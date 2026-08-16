/**
 * Integration tests for the returning-applicant service gap.
 *
 * Fixture shape: four terms in calendar order (FA24, SP25, FA25, SP26), one
 * department, and memberships placed to produce each case. The cycle recruits
 * for the last term.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { serviceGapForCycle, serviceGapsForCycle } from "./service-gap";

beforeEach(resetDb);

function utcNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

/** FA24, SP25, FA25, SP26, in calendar order. SP26 is the one being recruited for. */
async function seedTerms() {
  const specs = [
    { code: "GAPFA24", name: "Fall 2024", start: utcNoon(2024, 8, 26) },
    { code: "GAPSP25", name: "Spring 2025", start: utcNoon(2025, 1, 13) },
    { code: "GAPFA25", name: "Fall 2025", start: utcNoon(2025, 8, 25) },
    { code: "GAPSP26", name: "Spring 2026", start: utcNoon(2026, 1, 12) },
  ];
  const terms = [];
  for (const s of specs) {
    terms.push(
      await prisma.term.create({
        data: {
          code: s.code,
          name: s.name,
          startDate: s.start,
          endDate: new Date(s.start.getTime() + 120 * 86_400_000),
          status: "ARCHIVED",
        },
      }),
    );
  }
  return terms;
}

async function seedDept() {
  return prisma.department.create({ data: { code: "GAPD", name: "Gap Department" } });
}

async function member(personId: string, termId: string, departmentId: string) {
  return prisma.termMembership.create({
    data: { personId, termId, departmentId, kind: "VOLUNTEER", status: "ACTIVE" },
  });
}

describe("serviceGapForCycle", () => {
  it("reports no missed terms for someone who served the term immediately before", async () => {
    const [, , fa25, sp26] = await seedTerms();
    const dept = await seedDept();
    const person = await prisma.person.create({ data: { name: "Continuous" } });
    await member(person.id, fa25.id, dept.id);

    const gap = await serviceGapForCycle(person.id, sp26.id);
    expect(gap?.lastTerm.code).toBe("GAPFA25");
    expect(gap?.missedTerms).toEqual([]);
  });

  it("names the terms that ran without them, in calendar order", async () => {
    const [fa24, sp25, fa25, sp26] = await seedTerms();
    const dept = await seedDept();
    const person = await prisma.person.create({ data: { name: "Lapsed" } });
    await member(person.id, fa24.id, dept.id);
    // Both intervening terms ran: somebody else was on the roster for each.
    const other = await prisma.person.create({ data: { name: "Other" } });
    await member(other.id, sp25.id, dept.id);
    await member(other.id, fa25.id, dept.id);

    const gap = await serviceGapForCycle(person.id, sp26.id);
    expect(gap?.lastTerm.code).toBe("GAPFA24");
    expect(gap?.missedTerms.map((t) => t.code)).toEqual(["GAPSP25", "GAPFA25"]);
  });

  // A term nobody was ever on the roster for is a row in Admin, not a break in
  // service the applicant chose to take.
  it("ignores an intervening term the clinic never staffed", async () => {
    const [fa24, , fa25, sp26] = await seedTerms();
    const dept = await seedDept();
    const person = await prisma.person.create({ data: { name: "Lapsed" } });
    await member(person.id, fa24.id, dept.id);
    // FA25 ran; SP25 has no memberships at all.
    const other = await prisma.person.create({ data: { name: "Other" } });
    await member(other.id, fa25.id, dept.id);

    const gap = await serviceGapForCycle(person.id, sp26.id);
    expect(gap?.missedTerms.map((t) => t.code)).toEqual(["GAPFA25"]);
  });

  // Only the run-up matters: an earlier gap they already came back from is not
  // the question a reviewer is asking.
  it("measures only from their most recent term, not their first", async () => {
    const [fa24, sp25, fa25, sp26] = await seedTerms();
    const dept = await seedDept();
    const person = await prisma.person.create({ data: { name: "Returned once" } });
    await member(person.id, fa24.id, dept.id);
    await member(person.id, fa25.id, dept.id);
    const other = await prisma.person.create({ data: { name: "Other" } });
    await member(other.id, sp25.id, dept.id);

    const gap = await serviceGapForCycle(person.id, sp26.id);
    expect(gap?.lastTerm.code).toBe("GAPFA25");
    expect(gap?.missedTerms).toEqual([]);
  });

  it("returns null for someone who has never served", async () => {
    const [, , , sp26] = await seedTerms();
    await seedDept();
    const person = await prisma.person.create({ data: { name: "Brand new" } });

    expect(await serviceGapForCycle(person.id, sp26.id)).toBeNull();
  });

  // A membership in the term being recruited for must not read as "already
  // continuous": we are measuring the run-up to it.
  it("ignores a membership in the cycle's own term", async () => {
    const [fa24, sp25, fa25, sp26] = await seedTerms();
    const dept = await seedDept();
    const person = await prisma.person.create({ data: { name: "Already promoted" } });
    await member(person.id, fa24.id, dept.id);
    await member(person.id, sp26.id, dept.id);
    const other = await prisma.person.create({ data: { name: "Other" } });
    await member(other.id, sp25.id, dept.id);
    await member(other.id, fa25.id, dept.id);

    const gap = await serviceGapForCycle(person.id, sp26.id);
    expect(gap?.lastTerm.code).toBe("GAPFA24");
    expect(gap?.missedTerms.map((t) => t.code)).toEqual(["GAPSP25", "GAPFA25"]);
  });

  it("ignores a REMOVED membership: they were not on the roster", async () => {
    const [fa24, sp25, fa25, sp26] = await seedTerms();
    const dept = await seedDept();
    const person = await prisma.person.create({ data: { name: "Removed midterm" } });
    await member(person.id, fa24.id, dept.id);
    await prisma.termMembership.create({
      data: { personId: person.id, termId: fa25.id, departmentId: dept.id, kind: "VOLUNTEER", status: "REMOVED" },
    });
    const other = await prisma.person.create({ data: { name: "Other" } });
    await member(other.id, sp25.id, dept.id);
    await member(other.id, fa25.id, dept.id);

    const gap = await serviceGapForCycle(person.id, sp26.id);
    expect(gap?.lastTerm.code).toBe("GAPFA24");
    expect(gap?.missedTerms.map((t) => t.code)).toEqual(["GAPSP25", "GAPFA25"]);
  });

  it("returns an empty map for an unknown term", async () => {
    await seedTerms();
    const person = await prisma.person.create({ data: { name: "Someone" } });
    expect(await serviceGapsForCycle([person.id], "no-such-term")).toEqual(new Map());
  });
});

describe("serviceGapsForCycle", () => {
  // The roster asks for the whole page at once; each person's window is their
  // own, not the batch's.
  it("computes each person's gap against their own last term", async () => {
    const [fa24, sp25, fa25, sp26] = await seedTerms();
    const dept = await seedDept();
    const lapsed = await prisma.person.create({ data: { name: "Lapsed" } });
    const continuous = await prisma.person.create({ data: { name: "Continuous" } });
    const newcomer = await prisma.person.create({ data: { name: "Newcomer" } });
    await member(lapsed.id, fa24.id, dept.id);
    await member(continuous.id, fa25.id, dept.id);
    const other = await prisma.person.create({ data: { name: "Other" } });
    await member(other.id, sp25.id, dept.id);

    const map = await serviceGapsForCycle([lapsed.id, continuous.id, newcomer.id], sp26.id);
    expect(map.get(lapsed.id)?.missedTerms.map((t) => t.code)).toEqual(["GAPSP25", "GAPFA25"]);
    expect(map.get(continuous.id)?.missedTerms).toEqual([]);
    expect(map.has(newcomer.id)).toBe(false);
  });
});
