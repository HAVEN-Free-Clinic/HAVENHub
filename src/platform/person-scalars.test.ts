import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  ALL_PERSON_SCALARS_FOR_TEST,
  PERSON_DROP_PENDING,
  PERSON_SCALARS,
  omitPendingDrops,
} from "./person-scalars";

/**
 * Guards the projection that keeps the authenticated app up across a migration
 * that narrows Person.
 *
 * An earlier version of this file asserted that PERSON_SCALARS "names every
 * Person scalar, and nothing else". That assertion was the defect, not the
 * guard: a projection naming every column emits exactly the SQL a query with no
 * projection emits, the doomed column included, so it could never have saved the
 * old deployment during a build window. The test was pinning the broken shape in
 * place while docs/DEPLOY.md recorded the read path as fixed (audit 14,
 * person-scalars-projection-does-not-close-deploy-window).
 *
 * What actually closes the window is omitting the column one release BEFORE it
 * is dropped, which is what PERSON_DROP_PENDING is for. So the invariants are:
 * the full list still tracks the schema exactly (nothing silently missing), and
 * the exported projection is that list minus whatever is queued for removal.
 *
 * If this fails after a schema change, the fix is to add or remove the field in
 * ALL_PERSON_SCALARS, NOT to loosen the assertion.
 *
 * None of this can be asserted from inside the suite, because the failure it
 * prevents needs a database whose schema is AHEAD of the client's. Measured by
 * hand instead (2026-08-16, Prisma 6.19.3), and reproducible in about a minute:
 *
 *   createdb -T <test template> probe
 *   psql probe -c 'ALTER TABLE "Person" DROP COLUMN "dietaryRestrictions"'
 *   # then, against probe, with a client that still declares the column:
 *   #   findUnique({ where })                                  -> 42703
 *   #   findUnique({ where, select: ALL_PERSON_SCALARS })       -> 42703
 *   #   findUnique({ where, select: minus dietaryRestrictions })-> OK
 *
 * The middle line is the whole finding: the projection as originally written
 * failed identically to no projection at all.
 */
const personModel = Prisma.dmmf.datamodel.models.find((m) => m.name === "Person");

/** Scalars and enums only: relations are never part of a scalar projection. */
const schemaScalars = (personModel?.fields ?? [])
  .filter((f) => f.kind === "scalar" || f.kind === "enum")
  .map((f) => f.name)
  .sort();

describe("PERSON_SCALARS", () => {
  it("finds the Person model in the generated client", () => {
    // If this fails the rest of the suite is meaningless rather than passing
    // vacuously against an empty field list.
    expect(personModel).toBeDefined();
    expect(schemaScalars.length).toBeGreaterThan(20);
  });

  it("tracks every Person scalar in the schema, and nothing else", () => {
    expect(Object.keys(ALL_PERSON_SCALARS_FOR_TEST).sort()).toEqual(schemaScalars);
  });

  it("selects every field, never excludes one", () => {
    // A `false` here would silently drop a column from the result and produce
    // exactly the runtime shape this projection exists to make impossible.
    expect(Object.values(PERSON_SCALARS).every((v) => v === true)).toBe(true);
  });

  it("is the full list minus anything queued for removal", () => {
    const expected = schemaScalars.filter(
      (name) => !(PERSON_DROP_PENDING as readonly string[]).includes(name),
    );
    expect(Object.keys(PERSON_SCALARS).sort()).toEqual(expected);
  });

  it("has an empty drop queue, the normal state between migrations", () => {
    // A name left here after its DROP shipped would keep a live column out of
    // every projected read, which reads as data loss rather than a deploy
    // window. Release N+1 empties it in the same commit as the migration.
    expect(PERSON_DROP_PENDING).toEqual([]);
  });
});

describe("omitPendingDrops", () => {
  // The mechanism only runs on the day of a risky migration, which is the worst
  // possible day to discover it does not work.
  it("removes exactly the queued columns", () => {
    const all = { id: true, name: true, pronouns: true } as const;

    expect(omitPendingDrops(all, ["pronouns"])).toEqual({ id: true, name: true });
    expect(omitPendingDrops(all, ["pronouns", "name"])).toEqual({ id: true });
    expect(omitPendingDrops(all, [])).toEqual(all);
  });

  it("leaves the source object untouched", () => {
    // The full list is module state shared by every caller; mutating it would
    // make the projection depend on import order.
    const all = { id: true, pronouns: true };
    omitPendingDrops(all, ["pronouns"]);
    expect(all).toEqual({ id: true, pronouns: true });
  });
});
