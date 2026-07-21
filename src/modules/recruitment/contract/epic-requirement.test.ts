import { describe, it, expect } from "vitest";
import type { EpicRequirement, Track } from "@prisma/client";
import { epicRequirementFor, resolveEpicNeeded } from "./epic-requirement";

const dept = { requiresEpicDirector: "ALL" as const, requiresEpicVolunteer: "SOME" as const };

describe("epicRequirementFor", () => {
  it("reads the director column for the director track", () => {
    expect(epicRequirementFor(dept, "DIRECTOR")).toBe("ALL");
  });
  it("reads the volunteer column for the volunteer track", () => {
    expect(epicRequirementFor(dept, "VOLUNTEER")).toBe("SOME");
  });
  it("treats a missing department as NONE", () => {
    expect(epicRequirementFor(null, "DIRECTOR")).toBe("NONE");
  });
  it("treats a missing department as NONE for the volunteer track too", () => {
    expect(epicRequirementFor(null, "VOLUNTEER")).toBe("NONE");
  });

  const requirements: EpicRequirement[] = ["ALL", "NONE", "SOME"];
  const tracks: Track[] = ["DIRECTOR", "VOLUNTEER"];

  for (const directorReq of requirements) {
    for (const volunteerReq of requirements) {
      for (const track of tracks) {
        it(`reads the ${track} column when director=${directorReq} and volunteer=${volunteerReq}`, () => {
          const crossDept = {
            requiresEpicDirector: directorReq,
            requiresEpicVolunteer: volunteerReq,
          };
          const expected = track === "DIRECTOR" ? directorReq : volunteerReq;
          expect(epicRequirementFor(crossDept, track)).toBe(expected);
        });
      }
    }
  }
});

describe("resolveEpicNeeded", () => {
  it("is true for ALL regardless of the self report", () => {
    expect(resolveEpicNeeded("ALL", false)).toBe(true);
  });
  it("is false for NONE regardless of the self report", () => {
    expect(resolveEpicNeeded("NONE", true)).toBe(false);
  });
  it("defers to the self report for SOME", () => {
    expect(resolveEpicNeeded("SOME", true)).toBe(true);
    expect(resolveEpicNeeded("SOME", false)).toBe(false);
  });
});
