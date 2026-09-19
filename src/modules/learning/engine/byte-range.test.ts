import { describe, it, expect } from "vitest";
import { parseRange } from "./byte-range";

describe("parseRange", () => {
  it("reads an open-ended range, which is what a <video> sends", () => {
    expect(parseRange("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });
  it("reads a closed range, clamping the end to the object", () => {
    expect(parseRange("bytes=10-19", 1000)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=990-5000", 1000)).toEqual({ start: 990, end: 999 });
  });
  it("reads a suffix range", () => {
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  });
  it("rejects absent, malformed, multi-range, and unsatisfiable headers", () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange("bytes=-", 1000)).toBeNull();
    expect(parseRange("items=0-1", 1000)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 1000)).toBeNull();
    expect(parseRange("bytes=1000-", 1000)).toBeNull();
    expect(parseRange("bytes=20-10", 1000)).toBeNull();
  });
});
