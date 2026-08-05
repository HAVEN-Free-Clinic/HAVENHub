import { describe, it, expect } from "vitest";
import { HISTORY_SOURCES } from "./sources";

describe("HISTORY_SOURCES", () => {
  it("has a unique code per source", () => {
    const codes = HISTORY_SOURCES.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("never includes an excluded base", () => {
    // D-WN26 is a clone of D-FA25 and would duplicate all 89 of its applicants.
    const banned = ["appX9dVg2g9FDJlMl", "appJRUKtCBmg7w3Cp", "app7f51P5guqc8jou", "appIgxGgVKVeSNF72", "appXFdgWx7syySXZ1"];
    for (const source of HISTORY_SOURCES) expect(banned).not.toContain(source.baseId);
  });

  it("covers ten cycles plus the interest form", () => {
    expect(HISTORY_SOURCES).toHaveLength(11);
    expect(HISTORY_SOURCES.filter((s) => s.track === "VOLUNTEER" && s.code !== "INTEREST")).toHaveLength(6);
    expect(HISTORY_SOURCES.filter((s) => s.track === "DIRECTOR")).toHaveLength(4);
  });

  it("gives every non-interest source a term code", () => {
    for (const s of HISTORY_SOURCES) {
      if (s.code !== "INTEREST") expect(s.termCode).toBeTruthy();
    }
  });
});
