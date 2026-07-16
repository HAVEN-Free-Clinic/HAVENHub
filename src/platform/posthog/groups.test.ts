import { describe, expect, it } from "vitest";
import { GROUP_DEPARTMENT } from "./capture";
import { termGroup } from "./groups";

describe("termGroup", () => {
  it("builds a term group from a term id", () => {
    expect(termGroup("term-1")).toEqual({ term: "term-1" });
  });

  it("merges an extra department group alongside the term", () => {
    expect(termGroup("term-1", { [GROUP_DEPARTMENT]: "SRHD" })).toEqual({
      term: "term-1",
      department: "SRHD",
    });
  });

  it("returns only the extra groups when there is no term id", () => {
    expect(termGroup(null, { [GROUP_DEPARTMENT]: "SRHD" })).toEqual({
      department: "SRHD",
    });
  });

  it("returns undefined when there is nothing to attach", () => {
    expect(termGroup(null)).toBeUndefined();
    expect(termGroup(undefined)).toBeUndefined();
  });
});
