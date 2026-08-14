import { describe, it, expect } from "vitest";
import { isCycleOpen, canSubmitToCycle } from "./cycle-window";

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

describe("canSubmitToCycle", () => {
  const openCycle = { status: "OPEN", opensAt: null, closesAt: null };
  const closedCycle = { status: "CLOSED", opensAt: null, closesAt: null };
  const pastWindow = { status: "OPEN", opensAt: null, closesAt: past };

  it("matches isCycleOpen for an ordinary applicant", () => {
    expect(canSubmitToCycle(openCycle, now, { invited: false })).toBe(true);
    expect(canSubmitToCycle(closedCycle, now, { invited: false })).toBe(false);
    expect(canSubmitToCycle(pastWindow, now, { invited: false })).toBe(false);
  });

  it("lets an invitee through a CLOSED cycle", () => {
    // The whole point of an invite: recruiting someone selectively after the
    // deadline, without reopening the cycle to the public.
    expect(canSubmitToCycle(closedCycle, now, { invited: true })).toBe(true);
  });

  it("lets an invitee through an elapsed application window", () => {
    expect(canSubmitToCycle(pastWindow, now, { invited: true })).toBe(true);
  });

  it("does NOT let an invitee into an ARCHIVED cycle", () => {
    // Archiving is how a cycle is retired for good. A live invite against one is
    // a stale link, not a back door -- letting it through would attach a fresh
    // application to a cycle nobody is reviewing.
    const archived = { status: "ARCHIVED", opensAt: null, closesAt: null };
    expect(canSubmitToCycle(archived, now, { invited: true })).toBe(false);
  });

  it("does NOT let an invitee into a DRAFT cycle", () => {
    // A DRAFT cycle's form is still being built. Admitting anyone, invited or
    // not, would collect answers against questions that may still change.
    const draft = { status: "DRAFT", opensAt: null, closesAt: null };
    expect(canSubmitToCycle(draft, now, { invited: true })).toBe(false);
  });
});
