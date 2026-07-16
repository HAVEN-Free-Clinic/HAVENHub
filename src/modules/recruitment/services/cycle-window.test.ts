import { describe, it, expect } from "vitest";
import { isCycleOpen } from "./cycle-window";

const now = new Date("2026-07-09T12:00:00Z");
const past = new Date("2026-07-01T00:00:00Z");
const future = new Date("2026-08-01T00:00:00Z");

describe("isCycleOpen", () => {
  it("is open when status is OPEN and there is no window", () => {
    expect(isCycleOpen({ status: "OPEN", opensAt: null, closesAt: null }, now)).toBe(true);
  });

  it("is open when now is inside the window", () => {
    expect(isCycleOpen({ status: "OPEN", opensAt: past, closesAt: future }, now)).toBe(true);
  });

  it("is closed before opensAt", () => {
    expect(isCycleOpen({ status: "OPEN", opensAt: future, closesAt: null }, now)).toBe(false);
  });

  it("is closed after closesAt", () => {
    expect(isCycleOpen({ status: "OPEN", opensAt: null, closesAt: past }, now)).toBe(false);
  });

  it("treats the window boundaries as inclusive", () => {
    expect(isCycleOpen({ status: "OPEN", opensAt: now, closesAt: now }, now)).toBe(true);
  });

  it("is closed for any non-OPEN status regardless of window", () => {
    for (const status of ["DRAFT", "CLOSED", "ARCHIVED"]) {
      expect(isCycleOpen({ status, opensAt: past, closesAt: future }, now)).toBe(false);
    }
  });
});
