import { describe, it, expect } from "vitest";
import {
  deriveProfileTaskState,
  deriveHipaaTaskState,
  deriveTrainingTaskState,
  deriveLearningTaskState,
  deriveEhsTaskState,
  isSatisfied,
  summarize,
  computeGating,
} from "./status";

describe("deriveProfileTaskState", () => {
  it("is COMPLETE when contactEmail and phone are both present", () => {
    expect(deriveProfileTaskState({ contactEmail: "a@b.c", phone: "203" })).toBe("COMPLETE");
  });
  it("is INCOMPLETE when a required field is missing or blank", () => {
    expect(deriveProfileTaskState({ contactEmail: "a@b.c", phone: null })).toBe("INCOMPLETE");
    expect(deriveProfileTaskState({ contactEmail: "", phone: "203" })).toBe("INCOMPLETE");
    expect(deriveProfileTaskState({ contactEmail: "a@b.c", phone: "   " })).toBe("INCOMPLETE");
  });
});

describe("deriveHipaaTaskState", () => {
  it("is COMPLETE when compliant or expiring soon", () => {
    expect(deriveHipaaTaskState("COMPLIANT")).toBe("COMPLETE");
    expect(deriveHipaaTaskState("EXPIRING_SOON")).toBe("COMPLETE");
  });
  it("is INCOMPLETE otherwise", () => {
    expect(deriveHipaaTaskState("EXPIRED")).toBe("INCOMPLETE");
    expect(deriveHipaaTaskState("UNKNOWN_DATE")).toBe("INCOMPLETE");
    expect(deriveHipaaTaskState("NO_CERTIFICATE")).toBe("INCOMPLETE");
  });
});

describe("deriveTrainingTaskState", () => {
  it("is COMPLETE when state is COMPLETE", () => {
    expect(deriveTrainingTaskState({ state: "COMPLETE", attemptsUsed: 0 })).toBe("COMPLETE");
  });
  it("is IN_PROGRESS when pending with at least one attempt", () => {
    expect(deriveTrainingTaskState({ state: "PENDING", attemptsUsed: 2 })).toBe("IN_PROGRESS");
  });
  it("is INCOMPLETE when pending with no attempts", () => {
    expect(deriveTrainingTaskState({ state: "PENDING", attemptsUsed: 0 })).toBe("INCOMPLETE");
  });
});

describe("deriveLearningTaskState", () => {
  it("is NOT_REQUIRED when no courses are assigned", () => {
    expect(deriveLearningTaskState([])).toBe("NOT_REQUIRED");
  });
  it("is COMPLETE when every assigned course is complete", () => {
    expect(deriveLearningTaskState([{ status: "COMPLETE" }, { status: "COMPLETE" }])).toBe("COMPLETE");
  });
  it("is IN_PROGRESS when some progress exists but not all complete", () => {
    expect(deriveLearningTaskState([{ status: "COMPLETE" }, { status: "NOT_STARTED" }])).toBe("IN_PROGRESS");
    expect(deriveLearningTaskState([{ status: "IN_PROGRESS" }])).toBe("IN_PROGRESS");
  });
  it("is INCOMPLETE when nothing is started", () => {
    expect(deriveLearningTaskState([{ status: "NOT_STARTED" }, { status: "NOT_STARTED" }])).toBe("INCOMPLETE");
  });
});

describe("deriveEhsTaskState", () => {
  it("is NOT_REQUIRED when no active EHS trainings exist", () => {
    expect(deriveEhsTaskState([])).toBe("NOT_REQUIRED");
  });
  it("is COMPLETE when all items are complete", () => {
    expect(deriveEhsTaskState([{ complete: true }, { complete: true }])).toBe("COMPLETE");
  });
  it("is IN_PROGRESS when some but not all are complete", () => {
    expect(deriveEhsTaskState([{ complete: true }, { complete: false }])).toBe("IN_PROGRESS");
  });
  it("is INCOMPLETE when none are complete", () => {
    expect(deriveEhsTaskState([{ complete: false }, { complete: false }])).toBe("INCOMPLETE");
  });
});

describe("isSatisfied", () => {
  it("treats COMPLETE and NOT_REQUIRED as satisfied", () => {
    expect(isSatisfied("COMPLETE")).toBe(true);
    expect(isSatisfied("NOT_REQUIRED")).toBe(true);
    expect(isSatisfied("IN_PROGRESS")).toBe(false);
    expect(isSatisfied("INCOMPLETE")).toBe(false);
  });
});

describe("summarize", () => {
  it("counts satisfied tasks and flags onboarded only when all are satisfied", () => {
    expect(summarize(["COMPLETE", "NOT_REQUIRED", "COMPLETE", "COMPLETE"])).toEqual({
      completedCount: 4, totalCount: 4, onboarded: true,
    });
    expect(summarize(["COMPLETE", "INCOMPLETE", "IN_PROGRESS", "NOT_REQUIRED"])).toEqual({
      completedCount: 2, totalCount: 4, onboarded: false,
    });
  });
  it("treats an empty task list as onboarded (the dormant, no-active-term case)", () => {
    expect(summarize([])).toEqual({ completedCount: 0, totalCount: 0, onboarded: true });
  });
});

describe("computeGating", () => {
  it("keeps onboarded true when a non-blocking task is INCOMPLETE", () => {
    const tasks = [
      { state: "COMPLETE" as const, blocking: true },
      { state: "COMPLETE" as const, blocking: true },
      { state: "INCOMPLETE" as const, blocking: false },
    ];
    expect(computeGating(tasks)).toEqual({ onboarded: true, cleared: false });
  });

  it("sets both true when all tasks including non-blocking are satisfied", () => {
    const tasks = [
      { state: "COMPLETE" as const, blocking: true },
      { state: "COMPLETE" as const, blocking: false },
    ];
    expect(computeGating(tasks)).toEqual({ onboarded: true, cleared: true });
  });

  it("sets both false when a blocking task is INCOMPLETE", () => {
    const tasks = [
      { state: "INCOMPLETE" as const, blocking: true },
      { state: "COMPLETE" as const, blocking: false },
    ];
    expect(computeGating(tasks)).toEqual({ onboarded: false, cleared: false });
  });

  it("NOT_REQUIRED tasks always satisfy regardless of blocking flag", () => {
    const tasks = [
      { state: "COMPLETE" as const, blocking: true },
      { state: "NOT_REQUIRED" as const, blocking: false },
    ];
    expect(computeGating(tasks)).toEqual({ onboarded: true, cleared: true });
  });
});
