import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/modules/recruitment/services/training", () => ({ getMyTraining: vi.fn() }));
vi.mock("@/modules/learning/services/enrollment", () => ({ getMyCourses: vi.fn() }));
// EHS has its own real-DB behavior (access term, catalog applicability); here
// only how the answer composes it matters. Unconfigured, it resolves undefined,
// which the tool reads as "nothing outstanding" -- so the older tests below
// are unaffected by it existing.
vi.mock("./ehs", () => ({ outstandingEhsClause: vi.fn() }));
vi.mock("./links", () => ({ hubLink: vi.fn(async (path: string) => `https://hub.test${path}`) }));

import { getMyTraining } from "@/modules/recruitment/services/training";
import { getMyCourses } from "@/modules/learning/services/enrollment";
import { outstandingEhsClause } from "./ehs";
import { hubLink } from "./links";
import { myOutstandingTrainingTool } from "./training";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function training(trackLabel: string, termName: string, state: "COMPLETE" | "PENDING") {
  return { trackLabel, term: { id: "t1", name: termName }, state };
}

function course(title: string, status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE") {
  // `recurrence` rides along on MyCourseRow now. `mocked()` casts to an untyped
  // Mock so tsc would not have caught its absence; the fake matches the real row
  // anyway, because a fixture that has quietly stopped resembling the thing it
  // stands in for is how a mocked test starts proving nothing.
  return { id: title, title, description: null, status, recurrence: "ONCE" as const };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked(hubLink).mockImplementation(async (path: string) => `https://hub.test${path}`);
});

describe("my_outstanding_training", () => {
  it("names both outstanding track training and outstanding courses", async () => {
    mocked(getMyTraining).mockResolvedValue([training("Volunteer training", "Fall 2026", "PENDING")]);
    mocked(getMyCourses).mockResolvedValue([course("Bloodborne Pathogens", "NOT_STARTED")]);

    const text = await myOutstandingTrainingTool.run({ personId: "p1" }, {});

    expect(text).toContain("Volunteer training");
    expect(text).toContain("Fall 2026");
    expect(text).toContain("Bloodborne Pathogens");
  });

  it("renders a sensible sentence, not an empty list, when nothing is outstanding", async () => {
    mocked(getMyTraining).mockResolvedValue([training("Volunteer training", "Fall 2026", "COMPLETE")]);
    mocked(getMyCourses).mockResolvedValue([course("Bloodborne Pathogens", "COMPLETE")]);

    const text = await myOutstandingTrainingTool.run({ personId: "p1" }, {});

    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/no outstanding training, courses, or EHS/i);
    expect(text).not.toContain("Volunteer training");
    expect(text).not.toContain("Bloodborne Pathogens");
  });

  it("excludes completed items and only names the incomplete ones", async () => {
    mocked(getMyTraining).mockResolvedValue([
      training("Volunteer training", "Fall 2026", "COMPLETE"),
      training("Director training", "Fall 2026", "PENDING"),
    ]);
    mocked(getMyCourses).mockResolvedValue([
      course("Intro to HAVEN", "COMPLETE"),
      course("Bloodborne Pathogens", "IN_PROGRESS"),
    ]);

    const text = await myOutstandingTrainingTool.run({ personId: "p1" }, {});

    expect(text).not.toContain("Volunteer training");
    expect(text).not.toContain("Intro to HAVEN");
    expect(text).toContain("Director training");
    expect(text).toContain("Bloodborne Pathogens");
  });

  it("handles no training required at all the same as everything complete", async () => {
    mocked(getMyTraining).mockResolvedValue([]);
    mocked(getMyCourses).mockResolvedValue([]);

    const text = await myOutstandingTrainingTool.run({ personId: "p1" }, {});

    expect(text).toMatch(/no outstanding training, courses, or EHS/i);
  });

  it("reads only the caller's own record", async () => {
    mocked(getMyTraining).mockResolvedValue([]);
    mocked(getMyCourses).mockResolvedValue([]);

    await myOutstandingTrainingTool.run({ personId: "p1" }, {});

    expect(mocked(getMyTraining)).toHaveBeenCalledWith("p1");
    expect(mocked(getMyTraining)).toHaveBeenCalledTimes(1);
    expect(mocked(getMyCourses)).toHaveBeenCalledWith("p1");
    expect(mocked(getMyCourses)).toHaveBeenCalledTimes(1);
  });

  it("links the page each outstanding item is done on", async () => {
    mocked(getMyTraining).mockResolvedValue([training("Volunteer training", "Fall 2026", "PENDING")]);
    mocked(getMyCourses).mockResolvedValue([course("Bloodborne Pathogens", "NOT_STARTED")]);

    const text = await myOutstandingTrainingTool.run({ personId: "p1" }, {});

    expect(text).toContain("https://hub.test/training");
    expect(text).toContain("https://hub.test/learning");
  });

  it("answers an EHS-only gap instead of claiming everything is complete", async () => {
    // The ticket shape: track training and courses done, BBP not recorded.
    // Before EHS was included, this read "no outstanding training".
    mocked(getMyTraining).mockResolvedValue([training("Volunteer training", "Fall 2026", "COMPLETE")]);
    mocked(getMyCourses).mockResolvedValue([]);
    mocked(outstandingEhsClause).mockResolvedValue("EHS training not yet recorded: BBP Student.");

    const text = await myOutstandingTrainingTool.run({ personId: "p1" }, {});

    expect(text).toBe("EHS training not yet recorded: BBP Student.");
    expect(mocked(outstandingEhsClause)).toHaveBeenCalledWith("p1");
  });

  it("puts the EHS sentence after the training list, not spliced into it", async () => {
    mocked(getMyTraining).mockResolvedValue([training("Volunteer training", "Fall 2026", "PENDING")]);
    mocked(getMyCourses).mockResolvedValue([]);
    mocked(outstandingEhsClause).mockResolvedValue("EHS training not yet recorded: BBP Student.");

    const text = await myOutstandingTrainingTool.run({ personId: "p1" }, {});

    expect(text).toMatch(/^You still owe training: Volunteer training .*\. EHS training not yet recorded: BBP Student\.$/);
  });

  it("takes no input at all, so nothing about the request is model-chosen", () => {
    expect(Object.keys(myOutstandingTrainingTool.inputSchema.shape)).toEqual([]);
  });
});
