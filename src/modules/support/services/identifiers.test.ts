/**
 * Unit tests for the YNHH identifier normalisers.
 *
 * Both values are retyped off a YNHH email, so the cases that matter are the
 * transcription ones: surrounding whitespace, a pasted label, a stray newline,
 * an inconsistent case. The tests also pin the deliberate NON-rules, because a
 * later "tidy-up" that adds a format check is exactly how a correct RITM
 * prefix HAVEN has never seen before gets rejected at the worst moment.
 */

import { describe, it, expect } from "vitest";
import { normalizeEpicId, normalizeServiceRequestNumber } from "./identifiers";
import { SupportStateError } from "./tech-request";

describe("normalizeServiceRequestNumber", () => {
  it("trims and uppercases", () => {
    expect(normalizeServiceRequestNumber("  ritm0345759 ")).toBe("RITM0345759");
  });

  it("accepts a value already in the canonical shape unchanged", () => {
    expect(normalizeServiceRequestNumber("RITM0345759")).toBe("RITM0345759");
  });

  // The prefix is YNHH's to change, and HAVEN sees more than one already.
  it("does not care which prefix YNHH used", () => {
    expect(normalizeServiceRequestNumber("INC0012345")).toBe("INC0012345");
    expect(normalizeServiceRequestNumber("REQ-99")).toBe("REQ-99");
  });

  it("rejects a blank value", () => {
    expect(() => normalizeServiceRequestNumber("   ")).toThrow(SupportStateError);
  });

  // The classic paste: the label came along with the value.
  it("rejects a pasted label, naming the character that failed", () => {
    expect(() => normalizeServiceRequestNumber("RITM: RITM0345759")).toThrow(/":"/);
  });

  it("rejects an internal space", () => {
    expect(() => normalizeServiceRequestNumber("RITM 0345759")).toThrow(/a space/);
  });

  it("rejects a whole sentence rather than storing it", () => {
    expect(() => normalizeServiceRequestNumber("they said it is RITM0345759")).toThrow(SupportStateError);
  });

  it("rejects something far too long to be an identifier", () => {
    expect(() => normalizeServiceRequestNumber("R".repeat(65))).toThrow(/too long/);
  });
});

describe("normalizeEpicId", () => {
  it("trims and uppercases", () => {
    expect(normalizeEpicId(" carneyju\n")).toBe("CARNEYJU");
  });

  it("accepts a canonical id unchanged", () => {
    expect(normalizeEpicId("GALANVHT")).toBe("GALANVHT");
  });

  it("rejects a blank value", () => {
    expect(() => normalizeEpicId("")).toThrow(SupportStateError);
  });

  it("rejects an internal space", () => {
    expect(() => normalizeEpicId("CARNEY JU")).toThrow(/a space/);
  });

  it("rejects a pasted label", () => {
    expect(() => normalizeEpicId("Epic ID: CARNEYJU")).toThrow(SupportStateError);
  });

  // Shorter ceiling than an SR#: this lands on Person.epicId, which every later
  // MODIFY, RENEW and DEACTIVATE is raised against.
  it("rejects something far too long to be an Epic ID", () => {
    expect(() => normalizeEpicId("A".repeat(33))).toThrow(/too long/);
  });
});
