import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { PERSON_SCALARS } from "./person-scalars";

/**
 * Guards the projection that keeps the authenticated app up across a migration
 * that narrows Person.
 *
 * The type system already catches drift in both directions (see the module's own
 * doc comment), but a structural assignability error names neither the field nor
 * the reason. This asserts the same invariant against Prisma's DMMF so a failure
 * reads "PERSON_SCALARS is missing: spanishSelfReported" and points at the
 * deploy window rather than at a mismatched object type three files away.
 *
 * If this fails after a schema change, the fix is to add or remove the field
 * here, NOT to loosen the assertion.
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

  it("names every Person scalar in the schema, and nothing else", () => {
    expect(Object.keys(PERSON_SCALARS).sort()).toEqual(schemaScalars);
  });

  it("selects every field, never excludes one", () => {
    // A `false` here would silently drop a column from the result and produce
    // exactly the runtime shape this projection exists to make impossible.
    expect(Object.values(PERSON_SCALARS).every((v) => v === true)).toBe(true);
  });
});
