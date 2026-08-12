import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/modules/recruitment/services/training", () => ({ getMyTraining: vi.fn() }));
vi.mock("@/modules/learning/services/enrollment", () => ({ getMyCourses: vi.fn() }));

import { getMyTraining } from "@/modules/recruitment/services/training";
import { getMyCourses } from "@/modules/learning/services/enrollment";
import { myOutstandingTrainingTool } from "./training";

const mocked = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function training(trackLabel: string, termName: string, state: "COMPLETE" | "PENDING") {
  return { trackLabel, term: { id: "t1", name: termName }, state };
}

function course(title: string, status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE") {
  return { id: title, title, description: null, status };
}

beforeEach(() => {
  vi.resetAllMocks();
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
    expect(text).toMatch(/no outstanding training or courses/i);
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

    expect(text).toMatch(/no outstanding training or courses/i);
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

  it("takes no input at all, so nothing about the request is model-chosen", () => {
    expect(Object.keys(myOutstandingTrainingTool.inputSchema.shape)).toEqual([]);
  });
});
