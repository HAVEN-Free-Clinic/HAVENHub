/**
 * The Prisma client extension, exercised against a real database.
 *
 * person-name-write.test.ts covers the reconciliation rules in isolation. What
 * these prove is that the extension is actually WIRED: that an arbitrary
 * `prisma.person.create` anywhere in the codebase, including one written by
 * someone who has never read person-name.ts, still lands a row whose `name`
 * equals `displayNameOf` of its parts. Deleting the `$extends(...)` call in
 * platform/db.ts must fail these.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db";
import { resetDb } from "@/platform/test/db";
import { displayNameOf } from "./person-name";

describe("the person name write extension", () => {
  beforeEach(resetDb);

  it("splits a bare name written by a caller that knows nothing about parts", async () => {
    const person = await prisma.person.create({
      data: { name: "Jonathan (Jack) Carney", contactEmail: "jack@example.com" },
    });

    expect(person.legalFirstName).toBe("Jonathan");
    expect(person.lastName).toBe("Carney");
    expect(person.preferredFirstName).toBe("Jack");
    // Flagged: a lifted parenthetical is a guess, however plausible.
    expect(person.nameNeedsReview).toBe(true);
    // The parenthetical never reaches the column every roster renders.
    expect(person.name).toBe("Jack Carney");
  });

  it("flags a name it had to guess at", async () => {
    const person = await prisma.person.create({
      data: { name: "Maria de la Cruz", contactEmail: "maria@example.com" },
    });

    expect(person.lastName).toBe("de la Cruz");
    expect(person.nameNeedsReview).toBe(true);
  });

  it("derives the display name when the caller supplies parts instead", async () => {
    const person = await prisma.person.create({
      data: {
        legalFirstName: "Peggy",
        lastName: "Bia",
        preferredFirstName: "Margaret",
        contactEmail: "peggy@example.com",
      },
    });

    expect(person.name).toBe("Margaret Bia");
  });

  it("recomputes the display name when the parts change", async () => {
    const created = await prisma.person.create({
      data: { name: "Jonathan Carney", contactEmail: "jc@example.com" },
    });

    const updated = await prisma.person.update({
      where: { id: created.id },
      data: {
        legalFirstName: "Jonathan",
        lastName: "Carney",
        preferredFirstName: "Jack",
      },
    });

    expect(updated.name).toBe("Jack Carney");
    expect(updated.preferredFirstName).toBe("Jack");
  });

  it("leaves the name alone on a write that does not touch it", async () => {
    const created = await prisma.person.create({
      data: { name: "Jonathan (Jack) Carney", contactEmail: "jc2@example.com" },
    });

    const updated = await prisma.person.update({
      where: { id: created.id },
      data: { phone: "203-555-0100" },
    });

    expect(updated.name).toBe("Jack Carney");
    expect(updated.preferredFirstName).toBe("Jack");
  });

  it("refuses a partial parts update rather than deriving a wrong display name", async () => {
    const created = await prisma.person.create({
      data: { name: "Jonathan Carney", contactEmail: "jc3@example.com" },
    });

    await expect(
      prisma.person.update({
        where: { id: created.id },
        data: { preferredFirstName: "Jack" },
      }),
    ).rejects.toThrow(/legalFirstName and lastName/);
  });

  it("holds the invariant inside a transaction, where the extension is easiest to lose", async () => {
    const person = await prisma.$transaction(async (tx) =>
      tx.person.create({
        data: { name: "Guadalupe (Lupe) Hernandez Zavala", contactEmail: "lupe@example.com" },
      }),
    );

    expect(person.name).toBe("Lupe Zavala");
    expect(person.preferredFirstName).toBe("Lupe");
    expect(person.nameNeedsReview).toBe(true);
  });

  it("keeps name equal to the display name of the parts for every row it writes", async () => {
    for (const [i, name] of [
      "Jonathan (Jack) Carney",
      "Peggy (she/her) Bia",
      "Jane Doe, RN",
      "Carney, Jonathan",
      "Cher",
      "Maria de la Cruz",
    ].entries()) {
      const person = await prisma.person.create({
        data: { name, contactEmail: `row${i}@example.com` },
      });
      expect(person.name).toBe(displayNameOf(person));
    }
  });
});
