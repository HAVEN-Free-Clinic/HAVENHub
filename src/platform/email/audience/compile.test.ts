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
