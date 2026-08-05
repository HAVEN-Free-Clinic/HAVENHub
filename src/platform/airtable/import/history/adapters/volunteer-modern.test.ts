import { describe, it, expect } from "vitest";
import { transformModernVolunteer, MODERN_VOLUNTEER_FIELDS as F } from "./volunteer-modern";

const SOURCE = {
  code: "V-FA25", label: "Fall 2025 Volunteer Recruitment", track: "VOLUNTEER" as const,
  termCode: "FA25", baseId: "app0DXgMSFvsWW4t8", adapter: "volunteer-modern" as const,
  tables: { applications: "tblJPuEMyBq5c2x0W" },
};

const record = (id: string, fields: Record<string, unknown>) => ({ id, fields });

describe("transformModernVolunteer", () => {
  it("reads identity from the field ids, not names", () => {
    const [row] = transformModernVolunteer([record("rec1", {
      [F.firstName]: "Ada", [F.lastName]: "Lovelace",
      [F.email]: "Ada@Yale.edu", [F.netId]: "AL123",
    })], SOURCE);
    expect(row.identity).toEqual({ firstName: "Ada", lastName: "Lovelace", email: "Ada@Yale.edu", netId: "al123" });
    expect(row.source).toEqual({ baseId: SOURCE.baseId, tableId: "tblJPuEMyBq5c2x0W", recordId: "rec1" });
  });

  it("rejects a NetID-shaped check failure rather than writing it", () => {
    const [row] = transformModernVolunteer([record("rec1", {
      [F.email]: "a@yale.edu", [F.netId]: "not a netid!",
    })], SOURCE);
    expect(row.identity.netId).toBeNull();
    expect(row.unmapped).toMatchObject({ rejectedNetId: "not a netid!" });
  });

  it("derives ADVANCED from a non-empty Round 1 Selections link", () => {
    const [row] = transformModernVolunteer([record("rec1", {
      [F.email]: "a@yale.edu", [F.r1Selections]: ["recSel1"],
    })], SOURCE);
    expect(row.furthestStage).toBe("ADVANCED");
  });

  it("derives FINAL_ROUND from a Round 2 link", () => {
    const [row] = transformModernVolunteer([record("rec1", {
      [F.email]: "a@yale.edu", [F.r1Selections]: ["recSel1"], [F.r2Applications]: ["recR2"],
    })], SOURCE);
    expect(row.furthestStage).toBe("FINAL_ROUND");
  });

  it("reads the outcome from the FD Decision lookup and marks ACCEPTED", () => {
    const [row] = transformModernVolunteer([record("rec1", {
      [F.email]: "a@yale.edu", [F.finalDecisions]: ["recFD"], [F.fdDecision]: ["Accepted"],
    })], SOURCE);
    expect(row.outcome).toBe("ACCEPTED");
    expect(row.furthestStage).toBe("ACCEPTED");
  });

  it("treats an empty link array as absent", () => {
    const [row] = transformModernVolunteer([record("rec1", {
      [F.email]: "a@yale.edu", [F.r1Selections]: [],
    })], SOURCE);
    expect(row.furthestStage).toBe("APPLIED");
    expect(row.outcome).toBe("NO_DECISION");
  });

  it("falls back to the ACCEPTED? checkbox for SP26, which has nothing else", () => {
    const sp26 = { ...SOURCE, code: "V-SP26", baseId: "appsXFzmnfi5vWzrJ" };
    const [row] = transformModernVolunteer([record("rec1", {
      [F.email]: "a@yale.edu", [F.acceptedCheckbox]: true,
    })], sp26);
    expect(row.furthestStage).toBe("ACCEPTED");
    expect(row.outcome).toBe("ACCEPTED");
  });

  it("collects both department choices in rank order", () => {
    const [row] = transformModernVolunteer([record("rec1", {
      [F.email]: "a@yale.edu", [F.dept1]: "BVHD", [F.dept2]: "SCTP",
    })], SOURCE);
    expect(row.departmentChoicesRaw).toEqual(["BVHD", "SCTP"]);
  });

  it("skips rows with no email and no netId, which are Airtable cruft", () => {
    expect(transformModernVolunteer([record("rec1", {})], SOURCE)).toHaveLength(0);
  });
});
