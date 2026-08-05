import { describe, it, expect } from "vitest";
import type { AirtableRecord } from "../../../client";
import { transformVolunteerSu26, SU26_FIELDS as F } from "./volunteer-su26";

const SOURCE = {
  code: "V-SU26", label: "Summer 2026 Volunteer Recruitment", track: "VOLUNTEER" as const,
  termCode: "SU26", baseId: "appOq1yOiA1Lfzq8L", adapter: "volunteer-su26" as const,
  tables: { applicants: "tblV3UrQQvIIZzFTU" },
};

const record = (id: string, fields: Record<string, unknown>, createdTime?: string): AirtableRecord =>
  ({ id, fields, createdTime });
const only = (applicants: AirtableRecord[]) => ({ applicants });

describe("transformVolunteerSu26", () => {
  it("reads identity from the field ids, not names", () => {
    const [row] = transformVolunteerSu26(only([record("rec1", {
      [F.firstName]: "Ada", [F.lastName]: "Lovelace",
      [F.email]: "Ada@Yale.edu", [F.netId]: "AL123",
    })]), SOURCE);
    expect(row.identity).toEqual({ firstName: "Ada", lastName: "Lovelace", email: "Ada@Yale.edu", netId: "al123" });
    expect(row.source).toEqual({ baseId: SOURCE.baseId, tableId: "tblV3UrQQvIIZzFTU", recordId: "rec1" });
  });

  it("rejects a NetID-shaped check failure rather than writing it", () => {
    const [row] = transformVolunteerSu26(only([record("rec1", {
      [F.email]: "a@yale.edu", [F.netId]: "not a netid!",
    })]), SOURCE);
    expect(row.identity.netId).toBeNull();
    expect(row.unmapped).toMatchObject({ rejectedNetId: "not a netid!" });
  });

  it("derives ACCEPTED from a non-empty Acceptances link", () => {
    const [row] = transformVolunteerSu26(only([record("rec1", {
      [F.email]: "a@yale.edu", [F.acceptances]: ["recAcc1"],
    })]), SOURCE);
    expect(row.furthestStage).toBe("ACCEPTED");
    expect(row.outcome).toBe("ACCEPTED");
  });

  it("derives ONBOARDED from a non-empty Contracts link", () => {
    const [row] = transformVolunteerSu26(only([record("rec1", {
      [F.email]: "a@yale.edu", [F.acceptances]: ["recAcc1"], [F.contracts]: ["recCon1"],
    })]), SOURCE);
    expect(row.furthestStage).toBe("ONBOARDED");
  });

  it("treats an empty link array as absent", () => {
    const [row] = transformVolunteerSu26(only([record("rec1", {
      [F.email]: "a@yale.edu", [F.acceptances]: [],
    })]), SOURCE);
    expect(row.furthestStage).toBe("APPLIED");
    expect(row.outcome).toBe("NO_DECISION");
  });

  it("collects both department choices in rank order", () => {
    const [row] = transformVolunteerSu26(only([record("rec1", {
      [F.email]: "a@yale.edu", [F.dept1]: "BVHD", [F.dept2]: "SCTP",
    })]), SOURCE);
    expect(row.departmentChoicesRaw).toEqual(["BVHD", "SCTP"]);
  });

  it("reads the accepted department from the lookup", () => {
    const [row] = transformVolunteerSu26(only([record("rec1", {
      [F.email]: "a@yale.edu", [F.acceptances]: ["recAcc1"], [F.acceptedDept]: ["ITCM"],
    })]), SOURCE);
    expect(row.resultDepartmentRaw).toBe("ITCM");
  });

  it("skips rows with no email and no netId, which are Airtable cruft", () => {
    expect(transformVolunteerSu26(only([record("rec1", {})]), SOURCE)).toHaveLength(0);
  });

  it("reads the formula Primary Email when the direct Email field is empty", () => {
    // 197 of SU26's 358 rows look exactly like this.
    const [row] = transformVolunteerSu26(only([record("rec1", { [F.primaryEmail]: "linked@yale.edu" })]), SOURCE);
    expect(row).toBeDefined();
    expect(row.identity.email).toBe("linked@yale.edu");
  });

  it("unwraps a single-element array from the formula cell", () => {
    const [row] = transformVolunteerSu26(only([record("rec1", { [F.primaryEmail]: ["boxed@yale.edu"] })]), SOURCE);
    expect(row.identity.email).toBe("boxed@yale.edu");
  });

  it("prefers the formula Primary Email over the direct field when both are present", () => {
    const [row] = transformVolunteerSu26(only([record("rec1", {
      [F.primaryEmail]: "formula@yale.edu", [F.email]: "direct@yale.edu",
    })]), SOURCE);
    expect(row.identity.email).toBe("formula@yale.edu");
  });

  it("parses submittedAt from its own field when present", () => {
    const [row] = transformVolunteerSu26(only([record("rec1", {
      [F.email]: "a@yale.edu", [F.submittedAt]: "2026-01-10T08:00:00.000Z",
    })]), SOURCE);
    expect(row.submittedAt).toEqual(new Date("2026-01-10T08:00:00.000Z"));
  });

  it("falls back to the record's createdTime when its own field is absent", () => {
    const [row] = transformVolunteerSu26(only([record("rec1", {
      [F.email]: "a@yale.edu",
    }, "2026-01-05T08:00:00.000Z")]), SOURCE);
    expect(row.submittedAt).toEqual(new Date("2026-01-05T08:00:00.000Z"));
  });

  it("leaves submittedAt null, not an Invalid Date, when neither its own field nor createdTime is present", () => {
    const [row] = transformVolunteerSu26(only([record("rec1", {
      [F.email]: "a@yale.edu",
    })]), SOURCE);
    expect(row.submittedAt).toBeNull();
  });
});
