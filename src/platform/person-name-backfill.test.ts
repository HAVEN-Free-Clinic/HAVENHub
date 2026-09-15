import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { backfillPersonNames } from "./person-name-backfill";

/**
 * The backfill has to work on rows the client extension never touched: the
 * migration's crude SQL prefill left every existing person with a first token,
 * a last token, and nameNeedsReview = true. So these fixtures are written with
 * raw SQL, exactly as production rows arrive at the script.
 */
async function seedRawPerson(name: string): Promise<string> {
  const id = `p-${Math.random().toString(36).slice(2, 10)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Person" (id, name, "legalFirstName", "lastName", "nameNeedsReview", status, "createdAt", "updatedAt")
     VALUES ($1, $2, split_part(btrim($2), ' ', 1), '', true, 'ACTIVE', now(), now())`,
    id,
    name,
  );
  return id;
}

describe("backfillPersonNames", () => {
  beforeEach(resetDb);

  it("does not write anything on a dry run", async () => {
    const id = await seedRawPerson("Jonathan (Jack) Carney");

    const report = await backfillPersonNames({ dryRun: true });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ outcome: "split", preferredFirstName: "Jack" });
    const after = await prisma.person.findUniqueOrThrow({ where: { id } });
    expect(after.name).toBe("Jonathan (Jack) Carney");
    expect(after.preferredFirstName).toBeNull();
  });

  it("lifts a parenthetical into its own column and cleans the display name", async () => {
    const id = await seedRawPerson("Jonathan (Jack) Carney");

    await backfillPersonNames({ dryRun: false });

    const after = await prisma.person.findUniqueOrThrow({ where: { id } });
    expect(after.legalFirstName).toBe("Jonathan");
    expect(after.lastName).toBe("Carney");
    expect(after.preferredFirstName).toBe("Jack");
    expect(after.name).toBe("Jack Carney");
    // "Jack" is spelled like a given name, so the lift is trusted.
    expect(after.nameNeedsReview).toBe(false);
  });

  it("leaves an ambiguous name flagged, with its best guess written to the PARTS", async () => {
    const id = await seedRawPerson("Maria de la Cruz");

    const report = await backfillPersonNames({ dryRun: false });

    const after = await prisma.person.findUniqueOrThrow({ where: { id } });
    expect(after.lastName).toBe("de la Cruz");
    expect(after.nameNeedsReview).toBe(true);
    expect(report.counts.flagged).toBe(1);
  });

  /**
   * The rule the production dry run bought at the cost of nearly writing 44 wrong
   * names. A guessed split must not reach the column every roster, badge, email
   * and wallet pass renders: "Dariana Gil Hernandez" is ALREADY correct, and the
   * guess ("Dariana Hernandez") is worse than the string it would replace. The
   * parts are what nobody knows yet, so only the parts move.
   */
  it("does not touch the display name of a row it had to guess at", async () => {
    const compound = await seedRawPerson("Dariana Gil Hernandez");
    const korean = await seedRawPerson("Hye Young Choi");

    await backfillPersonNames({ dryRun: false });

    const a = await prisma.person.findUniqueOrThrow({ where: { id: compound } });
    expect(a.name).toBe("Dariana Gil Hernandez");
    expect(a.nameNeedsReview).toBe(true);
    // The parts still carry the guess, so the review queue has something to show.
    expect(a.legalFirstName).toBe("Dariana");

    const b = await prisma.person.findUniqueOrThrow({ where: { id: korean } });
    expect(b.name).toBe("Hye Young Choi");
    expect(b.nameNeedsReview).toBe(true);
  });

  it("still cleans the display name of a row it read with confidence", async () => {
    const id = await seedRawPerson("Jonathan (Jack) Carney");

    await backfillPersonNames({ dryRun: false });

    const after = await prisma.person.findUniqueOrThrow({ where: { id } });
    expect(after.name).toBe("Jack Carney");
    expect(after.nameNeedsReview).toBe(false);
  });

  it("does not re-guess a row a human already confirmed", async () => {
    const id = await seedRawPerson("Maria de la Cruz");
    await backfillPersonNames({ dryRun: false });
    await prisma.person.update({
      where: { id },
      data: { legalFirstName: "Maria", lastName: "de la Cruz", nameNeedsReview: false },
    });

    const report = await backfillPersonNames({ dryRun: false });

    const after = await prisma.person.findUniqueOrThrow({ where: { id } });
    expect(after.lastName).toBe("de la Cruz");
    expect(after.nameNeedsReview).toBe(false);
    expect(report.counts.skipped).toBe(1);
  });

  it("is safe to re-run: a second pass changes nothing and reports it", async () => {
    // A name it can read with confidence, so the first pass clears the flag and
    // the second has nothing left to do.
    await seedRawPerson("Jonathan Carney");
    await backfillPersonNames({ dryRun: false });

    const second = await backfillPersonNames({ dryRun: false });

    expect(second.counts.split).toBe(0);
    expect(second.counts.skipped).toBe(1);
  });

  it("counts a confident split apart from a flagged one", async () => {
    await seedRawPerson("Jonathan Carney");
    await seedRawPerson("Peggy (she/her) Bia");
    await seedRawPerson("Cher");
    await seedRawPerson("Carney, Jonathan");

    const report = await backfillPersonNames({ dryRun: false });

    expect(report.counts.split).toBe(2);
    expect(report.counts.flagged).toBe(2);
  });
});
