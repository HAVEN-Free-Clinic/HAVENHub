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
    expect(report.rows[0]).toMatchObject({ outcome: "flagged", preferredFirstName: "Jack" });
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
    // Left flagged: the lift is a guess, and this is the irreversible pass.
    expect(after.nameNeedsReview).toBe(true);
  });

  it("leaves an ambiguous name flagged, with its best guess written", async () => {
    const id = await seedRawPerson("Maria de la Cruz");

    const report = await backfillPersonNames({ dryRun: false });

    const after = await prisma.person.findUniqueOrThrow({ where: { id } });
    expect(after.lastName).toBe("de la Cruz");
    expect(after.nameNeedsReview).toBe(true);
    expect(report.counts.flagged).toBe(1);
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
