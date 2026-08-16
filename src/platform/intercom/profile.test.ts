import { describe, it, expect } from "vitest";
import { buildProfileAttributes } from "./profile";

describe("buildProfileAttributes", () => {
  it("carries every attribute when all are present", () => {
    const attrs = buildProfileAttributes({
      epicId: "E12345",
      netId: "abc123",
      departmentNames: ["JCTP", "SRR"],
      memberStatus: "ACTIVE",
      activeTerm: { name: "Summer 2026", cleared: true },
    });

    expect(attrs).toEqual({
      "Epic ID": "E12345",
      "Yale NetID": "abc123",
      Departments: "JCTP, SRR",
      "Member status": "ACTIVE",
      "Active term": "Summer 2026",
      "Clearance at last sign-in": "Cleared",
    });
  });

  it("omits Epic ID rather than sending an empty one when the person has none", () => {
    const attrs = buildProfileAttributes({
      epicId: null,
      netId: "abc123",
      departmentNames: [],
      memberStatus: "ACTIVE",
      activeTerm: null,
    });

    expect("Epic ID" in attrs).toBe(false);
  });

  it("omits Yale NetID when the person has none (e.g. a non-Yale member)", () => {
    const attrs = buildProfileAttributes({
      epicId: null,
      netId: null,
      departmentNames: [],
      memberStatus: "ACTIVE",
      activeTerm: null,
    });

    expect("Yale NetID" in attrs).toBe(false);
  });

  it("omits Departments when there are no active memberships this term", () => {
    const attrs = buildProfileAttributes({
      epicId: null,
      netId: null,
      departmentNames: [],
      memberStatus: "ACTIVE",
      activeTerm: { name: "Summer 2026", cleared: true },
    });

    expect("Departments" in attrs).toBe(false);
  });

  it("omits both Active term and Clearance at last sign-in when there is no active clinic term", () => {
    const attrs = buildProfileAttributes({
      epicId: null,
      netId: null,
      departmentNames: [],
      memberStatus: "ACTIVE",
      activeTerm: null,
    });

    expect("Active term" in attrs).toBe(false);
    expect("Clearance at last sign-in" in attrs).toBe(false);
  });

  it("always carries Member status, since Person.status is never null", () => {
    const attrs = buildProfileAttributes({
      epicId: null,
      netId: null,
      departmentNames: [],
      memberStatus: "OFFBOARDED",
      activeTerm: null,
    });

    expect(attrs["Member status"]).toBe("OFFBOARDED");
  });

  it("renders clearance as 'Not cleared' rather than a boolean when the member is not cleared", () => {
    const attrs = buildProfileAttributes({
      epicId: null,
      netId: null,
      departmentNames: [],
      memberStatus: "ACTIVE",
      activeTerm: { name: "Summer 2026", cleared: false },
    });

    expect(attrs["Clearance at last sign-in"]).toBe("Not cleared");
  });

  it("joins multiple department names with a comma", () => {
    const attrs = buildProfileAttributes({
      epicId: null,
      netId: null,
      departmentNames: ["JCTP", "SRR", "ITCM"],
      memberStatus: "ACTIVE",
      activeTerm: null,
    });

    expect(attrs["Departments"]).toBe("JCTP, SRR, ITCM");
  });

  it("returns only Member status when nothing else is present", () => {
    const attrs = buildProfileAttributes({
      epicId: null,
      netId: null,
      departmentNames: [],
      memberStatus: "ACTIVE",
      activeTerm: null,
    });

    expect(Object.keys(attrs)).toEqual(["Member status"]);
  });
});
