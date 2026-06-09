import { describe, expect, it } from "vitest";
import { compilePersonWhere } from "./compile";

const ctx = { activeTermId: "t1" };

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
});
