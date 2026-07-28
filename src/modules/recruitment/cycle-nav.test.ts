import { describe, it, expect } from "vitest";
import { cycleNavItems } from "./cycle-nav";

const CYCLE_ID = "cyc_123";

describe("cycleNavItems", () => {
  it("shows Subcommittees and not Interviews for a full-permission VOLUNTEER cycle", () => {
    const items = cycleNavItems({ cycleId: CYCLE_ID, track: "VOLUNTEER", canManage: true, canReviewAll: true });
    const labels = items.map((i) => i.label);
    expect(labels).toContain("Subcommittees");
    expect(labels).not.toContain("Interviews");
  });

  it("shows Interviews and not Subcommittees for a full-permission DIRECTOR cycle", () => {
    const items = cycleNavItems({ cycleId: CYCLE_ID, track: "DIRECTOR", canManage: true, canReviewAll: true });
    const labels = items.map((i) => i.label);
    expect(labels).toContain("Interviews");
    expect(labels).not.toContain("Subcommittees");
  });

  it("hides Form, Contract, Emails, and Quiz when canManage is false", () => {
    const items = cycleNavItems({ cycleId: CYCLE_ID, track: "VOLUNTEER", canManage: false, canReviewAll: true });
    const labels = items.map((i) => i.label);
    expect(labels).not.toContain("Form");
    expect(labels).not.toContain("Contract");
    expect(labels).not.toContain("Emails");
    expect(labels).not.toContain("Quiz");
  });

  it("hides Decisions and Onboarding when canReviewAll is false", () => {
    const items = cycleNavItems({ cycleId: CYCLE_ID, track: "VOLUNTEER", canManage: true, canReviewAll: false });
    const labels = items.map((i) => i.label);
    expect(labels).not.toContain("Decisions");
    expect(labels).not.toContain("Onboarding");
  });

  it("still shows the always-on set for a viewer with neither permission", () => {
    const items = cycleNavItems({ cycleId: CYCLE_ID, track: "VOLUNTEER", canManage: false, canReviewAll: false });
    const labels = items.map((i) => i.label);
    expect(labels).toEqual(["Overview", "Applicants", "Waitlist", "Training"]);
  });

  it("gives a VOLUNTEER viewer with neither permission no Subcommittees tab either", () => {
    const items = cycleNavItems({ cycleId: CYCLE_ID, track: "VOLUNTEER", canManage: false, canReviewAll: false });
    expect(items.map((i) => i.label)).not.toContain("Subcommittees");
  });

  it("shows Speed route for a canReviewAll VOLUNTEER cycle", () => {
    const items = cycleNavItems({ cycleId: CYCLE_ID, track: "VOLUNTEER", canManage: false, canReviewAll: true });
    expect(items.map((i) => i.label)).toContain("Speed route");
  });

  it("hides Speed route when canReviewAll is false", () => {
    const items = cycleNavItems({ cycleId: CYCLE_ID, track: "VOLUNTEER", canManage: true, canReviewAll: false });
    expect(items.map((i) => i.label)).not.toContain("Speed route");
  });

  it("hides Speed route on a DIRECTOR cycle even with canReviewAll", () => {
    const items = cycleNavItems({ cycleId: CYCLE_ID, track: "DIRECTOR", canManage: true, canReviewAll: true });
    expect(items.map((i) => i.label)).not.toContain("Speed route");
  });

  it("gives every href a path under the cycle's own workspace", () => {
    const items = cycleNavItems({ cycleId: CYCLE_ID, track: "DIRECTOR", canManage: true, canReviewAll: true });
    for (const item of items) {
      expect(item.href.startsWith(`/recruitment/cycles/${CYCLE_ID}`)).toBe(true);
    }
  });

  it("puts Overview first regardless of permission combination", () => {
    const combos = [
      { track: "VOLUNTEER" as const, canManage: true, canReviewAll: true },
      { track: "DIRECTOR" as const, canManage: false, canReviewAll: false },
      { track: "VOLUNTEER" as const, canManage: false, canReviewAll: true },
    ];
    for (const combo of combos) {
      const items = cycleNavItems({ cycleId: CYCLE_ID, ...combo });
      expect(items[0].label).toBe("Overview");
    }
  });

  it("shows the full tab set for a full-permission DIRECTOR cycle", () => {
    const items = cycleNavItems({ cycleId: CYCLE_ID, track: "DIRECTOR", canManage: true, canReviewAll: true });
    expect(items.map((i) => i.label)).toEqual([
      "Overview",
      "Form",
      "Contract",
      "Applicants",
      "Waitlist",
      "Decisions",
      "Interviews",
      "Onboarding",
      "Emails",
      "Quiz",
      "Training",
    ]);
  });

  it("shows the full tab set for a full-permission VOLUNTEER cycle", () => {
    const items = cycleNavItems({ cycleId: CYCLE_ID, track: "VOLUNTEER", canManage: true, canReviewAll: true });
    expect(items.map((i) => i.label)).toEqual([
      "Overview",
      "Form",
      "Contract",
      "Applicants",
      "Speed route",
      "Waitlist",
      "Decisions",
      "Subcommittees",
      "Onboarding",
      "Emails",
      "Quiz",
      "Training",
    ]);
  });
});
