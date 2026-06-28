import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { needsSpanishReview, spanishReviewWhere } from "./spanish-review";

describe("needsSpanishReview (pure predicate)", () => {
  it("not Spanish -> not in queue", () => {
    expect(needsSpanishReview({ spanishSelfReported: false, spanishVerified: false, spanishVerifiedAt: null })).toBe(false);
  });

  it("self-reported, never assessed -> in queue", () => {
    expect(needsSpanishReview({ spanishSelfReported: true, spanishVerified: false, spanishVerifiedAt: null })).toBe(true);
  });

  it("assessed yes -> not in queue", () => {
    expect(needsSpanishReview({ spanishSelfReported: true, spanishVerified: true, spanishVerifiedAt: new Date() })).toBe(false);
  });

  it("assessed no -> not in queue", () => {
    expect(needsSpanishReview({ spanishSelfReported: true, spanishVerified: false, spanishVerifiedAt: new Date() })).toBe(false);
  });

  it("verified but unstamped (defensive) -> in queue", () => {
    expect(needsSpanishReview({ spanishSelfReported: false, spanishVerified: true, spanishVerifiedAt: null })).toBe(true);
  });
});

describe("spanishReviewWhere (Prisma query)", () => {
  beforeEach(resetDb);

  it("returns exactly the people awaiting assessment", async () => {
    const notSpanish = await prisma.person.create({ data: { name: "None" } });
    const awaiting = await prisma.person.create({
      data: { name: "Awaiting", spanishSelfReported: true },
    });
    const assessedYes = await prisma.person.create({
      data: { name: "Yes", spanishSelfReported: true, spanishVerified: true, spanishVerifiedAt: new Date() },
    });
    const assessedNo = await prisma.person.create({
      data: { name: "No", spanishSelfReported: true, spanishVerifiedAt: new Date() },
    });

    const rows = await prisma.person.findMany({ where: spanishReviewWhere(), select: { id: true } });
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(awaiting.id);
    expect(ids).not.toContain(notSpanish.id);
    expect(ids).not.toContain(assessedYes.id);
    expect(ids).not.toContain(assessedNo.id);
  });
});
