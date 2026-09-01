import { describe, expect, it } from "vitest";
import { compilePersonWhere } from "./compile";

const ctx = { activeTermId: "t1", now: new Date("2026-01-01T12:00:00.000Z"), zone: "America/New_York" as const };

describe("compilePersonWhere", () => {
  it("ALL -> AND of fragments", () => {
    const where = compilePersonWhere(
      { recordType: "PERSON", match: "ALL", conditions: [
        { field: "status", op: "eq", value: "ACTIVE" },
        { field: "role", op: "eq", value: "VOLUNTEER" },
      ] }, ctx);
    expect(where).toEqual({ AND: [
      { status: "ACTIVE" },
      { memberships: { some: { termId: "t1", status: "ACTIVE", kind: "VOLUNTEER" } } },
    ] });
  });

  it("ANY -> OR of fragments", () => {
    const where = compilePersonWhere(
      { recordType: "PERSON", match: "ANY", conditions: [
        { field: "status", op: "eq", value: "ACTIVE" },
        { field: "hasEpicId", op: "isTrue" },
      ] }, ctx);
    expect(where).toEqual({ OR: [{ status: "ACTIVE" }, { epicId: { not: null } }] });
  });

  it("no conditions -> match nothing (guards against an accidental send-all)", () => {
    expect(compilePersonWhere({ recordType: "PERSON", match: "ALL", conditions: [] }, ctx)).toEqual({ id: { in: [] } });
  });

  it("nested groups compose AND/OR recursively", () => {
    const where = compilePersonWhere(
      { recordType: "PERSON", match: "ANY", conditions: [
        { field: "status", op: "eq", value: "ACTIVE" },
        { match: "ALL", children: [
          { field: "role", op: "eq", value: "VOLUNTEER" },
          { field: "licensedRN", op: "isTrue" },
        ] },
      ] }, ctx);
    expect(where).toEqual({ OR: [
      { status: "ACTIVE" },
      { AND: [
        { memberships: { some: { termId: "t1", status: "ACTIVE", kind: "VOLUNTEER" } } },
        { licensedRN: true },
      ] },
    ] });
  });

  it("an empty nested group matches nobody (never everyone)", () => {
    const where = compilePersonWhere(
      { recordType: "PERSON", match: "ALL", conditions: [
        { field: "status", op: "eq", value: "ACTIVE" },
        { match: "ALL", children: [] },
      ] }, ctx);
    expect(where).toEqual({ AND: [{ status: "ACTIVE" }, { id: { in: [] } }] });
  });

  it("NONE -> NOT over the OR of its children", () => {
    const where = compilePersonWhere(
      { recordType: "PERSON", match: "ALL", conditions: [
        { field: "status", op: "eq", value: "ACTIVE" },
        { match: "NONE", children: [
          { field: "licensedRN", op: "isTrue" },
          { field: "hasEpicId", op: "isTrue" },
        ] },
      ] }, ctx);
    expect(where).toEqual({ AND: [
      { status: "ACTIVE" },
      { NOT: { OR: [{ licensedRN: true }, { epicId: { not: null } }] } },
    ] });
  });

  // The single most dangerous shape in the whole tree: `NOT { OR: [] }` is
  // vacuously TRUE, so an empty NONE group would mail every Person in the
  // database. The empty-children check has to run BEFORE the match mode.
  it("an empty NONE group matches nobody, not everyone", () => {
    const where = compilePersonWhere(
      { recordType: "PERSON", match: "ALL", conditions: [
        { match: "NONE", children: [] },
      ] }, ctx);
    expect(where).toEqual({ AND: [{ id: { in: [] } }] });
  });

  // The reachable version of the "always-false leaf widens NONE" hazard above:
  // a date condition landing on an operator its own field never declares (the
  // enum-shaped fallback `defaultConditionFor` used to hand every date field
  // before it grew its own branch -- see audience-builder.tsx) hits
  // personFieldWhere's operator gate, which returns MATCH_NOBODY. Fixed by
  // giving `defaultConditionFor` a `date` branch that always picks a real,
  // field-declared operator (`onOrAfter`); this test locks in that a
  // WELL-FORMED date condition compiles to a real predicate, not MATCH_NOBODY,
  // so it narrows a NONE group instead of vacuously matching everyone.
  it("a well-formed date condition narrows a NONE group instead of vacuously matching everyone", () => {
    const where = compilePersonWhere(
      { recordType: "PERSON", match: "ALL", conditions: [
        { match: "NONE", children: [
          { field: "joinedAt", op: "onOrAfter", value: "2026-06-01" },
        ] },
      ] }, ctx);
    expect(where).toEqual({ AND: [
      { NOT: { OR: [{ createdAt: { gte: new Date("2026-06-01T04:00:00.000Z") } }] } },
    ] });
  });

  // Documents the residual, deliberately-not-fully-closed hazard: an operator
  // a field does NOT declare (reachable only via a hand-edited or stale stored
  // audience now that defaultConditionFor always picks a valid one -- see the
  // test above and audience-builder.test.tsx) still compiles to MATCH_NOBODY
  // via the gate in personFieldWhere, which still widens a NONE group to
  // everyone. See the comment on that gate in person-fields.ts for why this was
  // kept as MATCH_NOBODY rather than made to throw.
  it("an operator a field does not declare still widens a NONE group (documented, pre-existing hazard)", () => {
    const where = compilePersonWhere(
      { recordType: "PERSON", match: "ALL", conditions: [
        { match: "NONE", children: [
          // "eq" is not a member of DATE_OPERATORS; joinedAt never declares it.
          { field: "joinedAt", op: "eq" as never, value: "2026-06-01" },
        ] },
      ] }, ctx);
    expect(where).toEqual({ AND: [{ NOT: { OR: [{ id: { in: [] } }] } }] });
  });

  it("a NONE group nests inside another group", () => {
    const where = compilePersonWhere(
      { recordType: "PERSON", match: "ANY", conditions: [
        { match: "ALL", children: [
          { field: "role", op: "eq", value: "VOLUNTEER" },
          { match: "NONE", children: [{ field: "hasApprovedStrike", op: "isTrue" }] },
        ] },
      ] }, ctx);
    expect(where).toEqual({ OR: [
      { AND: [
        { memberships: { some: { termId: "t1", status: "ACTIVE", kind: "VOLUNTEER" } } },
        { NOT: { OR: [{ incidentSubjectLinks: { some: { strikeDecision: "APPROVED" } } }] } },
      ] },
    ] });
  });
});
