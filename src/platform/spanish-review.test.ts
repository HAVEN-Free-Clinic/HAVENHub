import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { needsSpanishReview, spanishReviewWhere, recordSpanishAssessment, listSpanishReviewQueue } from "./spanish-review";
import { PersonNotFoundError } from "@/platform/people";

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

describe("recordSpanishAssessment", () => {
  beforeEach(resetDb);
  const ACTOR = "actor-1";

  it("verify=true sets verified, stamps verifier+timestamp, audits, and leaves the queue", async () => {
    const p = await prisma.person.create({ data: { name: "Self", spanishSelfReported: true } });
    const updated = await recordSpanishAssessment(ACTOR, p.id, true);
    expect(updated.spanishVerified).toBe(true);
    expect(updated.spanishVerifiedById).toBe(ACTOR);
    expect(updated.spanishVerifiedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "person.spanish_assess", entityId: p.id } })).toBe(1);
    const queue = await prisma.person.findMany({ where: spanishReviewWhere(), select: { id: true } });
    expect(queue.map((r) => r.id)).not.toContain(p.id);
  });

  it("verify=false still stamps verifiedAt (assessed-no) and leaves the queue", async () => {
    const p = await prisma.person.create({ data: { name: "Self", spanishSelfReported: true } });
    const updated = await recordSpanishAssessment(ACTOR, p.id, false);
    expect(updated.spanishVerified).toBe(false);
    expect(updated.spanishVerifiedAt).not.toBeNull();
    expect(updated.spanishVerifiedById).toBe(ACTOR);
    const queue = await prisma.person.findMany({ where: spanishReviewWhere(), select: { id: true } });
    expect(queue.map((r) => r.id)).not.toContain(p.id);
  });

  it("throws PersonNotFoundError for a missing id", async () => {
    await expect(recordSpanishAssessment(ACTOR, "nope", true)).rejects.toBeInstanceOf(PersonNotFoundError);
  });
});

describe("listSpanishReviewQueue", () => {
  beforeEach(resetDb);

  it("returns self-reported-unverified people ordered by name, excluding not-Spanish and assessed", async () => {
    await prisma.person.create({ data: { name: "Zed", spanishSelfReported: true } });
    await prisma.person.create({ data: { name: "Amy", spanishSelfReported: true } });
    await prisma.person.create({ data: { name: "NotSpanish" } });
    await prisma.person.create({ data: { name: "AssessedYes", spanishSelfReported: true, spanishVerified: true, spanishVerifiedAt: new Date() } });
    const rows = await listSpanishReviewQueue();
    expect(rows.map((r) => r.name)).toEqual(["Amy", "Zed"]);
  });
});
