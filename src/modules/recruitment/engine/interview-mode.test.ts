import { describe, expect, it } from "vitest";
import { isDecidedWithoutInterview, isInterviewUnderWay, rankedDirectorDepartments } from "./interview-mode";

describe("isDecidedWithoutInterview", () => {
  it("is true for a decided row with no time and no evaluations", () => {
    expect(isDecidedWithoutInterview({ decision: "REJECT", scheduledAt: null, evaluationCount: 0 })).toBe(true);
    expect(isDecidedWithoutInterview({ decision: "ACCEPT", scheduledAt: null, evaluationCount: 0 })).toBe(true);
  });
  it("is false while the row is still pending", () => {
    expect(isDecidedWithoutInterview({ decision: "PENDING", scheduledAt: null, evaluationCount: 0 })).toBe(false);
  });
  it("is false once a time was set or a panelist evaluated", () => {
    expect(isDecidedWithoutInterview({ decision: "ACCEPT", scheduledAt: new Date(), evaluationCount: 0 })).toBe(false);
    expect(isDecidedWithoutInterview({ decision: "ACCEPT", scheduledAt: null, evaluationCount: 1 })).toBe(false);
  });
});

describe("isInterviewUnderWay", () => {
  it("is false for a bare row", () => {
    expect(isInterviewUnderWay({ scheduledAt: null, invitedAt: null, evaluationCount: 0 })).toBe(false);
  });
  it("is true once any of time, invite, or evaluation exists", () => {
    expect(isInterviewUnderWay({ scheduledAt: new Date(), invitedAt: null, evaluationCount: 0 })).toBe(true);
    expect(isInterviewUnderWay({ scheduledAt: null, invitedAt: new Date(), evaluationCount: 0 })).toBe(true);
    expect(isInterviewUnderWay({ scheduledAt: null, invitedAt: null, evaluationCount: 2 })).toBe(true);
  });
});

describe("rankedDirectorDepartments", () => {
  it("keeps ranked order and drops departments outside the cycle", () => {
    expect(rankedDirectorDepartments({ departmentChoices: ["PEDS", "XXXX", "EDUC"], renewalDepartment: null }, ["EDUC", "PEDS"])).toEqual(["PEDS", "EDUC"]);
  });
  it("includes a renewal's department without repeating it", () => {
    expect(rankedDirectorDepartments({ departmentChoices: ["EDUC"], renewalDepartment: "EDUC" }, ["EDUC"])).toEqual(["EDUC"]);
    expect(rankedDirectorDepartments({ departmentChoices: [], renewalDepartment: "EDUC" }, ["EDUC", "PEDS"])).toEqual(["EDUC"]);
  });
});
