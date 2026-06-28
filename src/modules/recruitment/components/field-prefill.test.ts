import { describe, expect, it } from "vitest";
import { asPrefillList, isPrefillChecked, prefillString } from "./field-prefill";

describe("asPrefillList", () => {
  it("returns an empty list for undefined", () => {
    expect(asPrefillList(undefined)).toEqual([]);
  });
  it("wraps a single string in a list", () => {
    expect(asPrefillList("a")).toEqual(["a"]);
  });
  it("passes through a string array", () => {
    expect(asPrefillList(["a", "b"])).toEqual(["a", "b"]);
  });
  it("preserves empty-string ranks so positional indexing stays aligned", () => {
    // Subcommittee rank serializes one value per rank, "" for an unranked slot.
    expect(asPrefillList(["a", "", "c"])).toEqual(["a", "", "c"]);
  });
  it("drops non-string members", () => {
    expect(asPrefillList(["a", 2 as unknown as string, null as unknown as string])).toEqual(["a"]);
  });
  it("returns an empty list for a file-object answer", () => {
    expect(asPrefillList({ storedName: "x", fileName: "cv.pdf" })).toEqual([]);
  });
});

describe("prefillString", () => {
  it("returns the string as-is", () => {
    expect(prefillString("SRHD")).toBe("SRHD");
  });
  it("returns empty for undefined", () => {
    expect(prefillString(undefined)).toBe("");
  });
  it("returns empty for an array (not a single value)", () => {
    expect(prefillString(["a", "b"])).toBe("");
  });
  it("returns empty for a file-object answer", () => {
    expect(prefillString({ storedName: "x" })).toBe("");
  });
});

describe("isPrefillChecked", () => {
  it("treats the html checkbox value 'on' as checked", () => {
    expect(isPrefillChecked("on")).toBe(true);
  });
  it("treats boolean true as checked", () => {
    expect(isPrefillChecked(true)).toBe(true);
  });
  it("is unchecked for undefined", () => {
    expect(isPrefillChecked(undefined)).toBe(false);
  });
  it("is unchecked for an empty string", () => {
    expect(isPrefillChecked("")).toBe(false);
  });
});
