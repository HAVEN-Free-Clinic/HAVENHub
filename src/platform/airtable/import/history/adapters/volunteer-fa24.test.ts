import { describe, it, expect } from "vitest";
import type { AirtableRecord } from "../../../client";
import { transformVolunteerFa24, FA24_FIELDS as F } from "./volunteer-fa24";
import { HISTORY_SOURCES } from "../sources";

const SOURCE = HISTORY_SOURCES.find((s) => s.code === "V-FA24")!;
const rec = (id: string, fields: Record<string, unknown>, createdTime?: string): AirtableRecord =>
  ({ id, fields, createdTime });
const empty = { r1New: [], r1Returning: [], r1Switch: [], r1Ineligible: [], nonYale: [], r2All: [], finalDecisions: [] };

describe("transformVolunteerFa24", () => {
  it("emits one row per applicant across every R1 table", () => {
    const rows = transformVolunteerFa24({
      ...empty,
      r1New: [rec("recN", { [F.r1New.email]: "new@yale.edu" })],
      r1Returning: [rec("recR", { [F.r1Returning.email]: "ret@yale.edu" })],
      r1Switch: [rec("recS", { [F.r1Switch.email]: "sw@yale.edu" })],
    }, SOURCE);
    expect(rows).toHaveLength(3);
  });

  it("derives applicantType from which table the row came from", () => {
    const rows = transformVolunteerFa24({
      ...empty,
      r1New: [rec("recN", { [F.r1New.email]: "new@yale.edu" })],
      r1Returning: [rec("recR", { [F.r1Returning.email]: "ret@yale.edu" })],
      r1Switch: [rec("recS", { [F.r1Switch.email]: "sw@yale.edu" })],
    }, SOURCE);
    expect(rows.find((r) => r.source.recordId === "recN")!.applicantType).toBe("NEW");
    expect(rows.find((r) => r.source.recordId === "recR")!.applicantType).toBe("RENEWAL");
    expect(rows.find((r) => r.source.recordId === "recS")!.applicantType).toBe("TRANSFER");
  });

  it("never sets a netId, because FA24 has no NetID field", () => {
    const [row] = transformVolunteerFa24({
      ...empty, r1New: [rec("recN", { [F.r1New.email]: "a@yale.edu" })],
    }, SOURCE);
    expect(row.identity.netId).toBeNull();
  });

  it("derives FINAL_ROUND by matching email into [R2] All, since there are no links", () => {
    const [row] = transformVolunteerFa24({
      ...empty,
      r1New: [rec("recN", { [F.r1New.email]: "Ada@Yale.edu" })],
      r2All: [rec("recR2", { [F.r2All.email]: "ada@yale.edu" })],
    }, SOURCE);
    expect(row.furthestStage).toBe("FINAL_ROUND");
  });

  it("derives ONBOARDED from the Final Decisions Onboarded checkbox", () => {
    const [row] = transformVolunteerFa24({
      ...empty,
      r1New: [rec("recN", { [F.r1New.email]: "ada@yale.edu" })],
      finalDecisions: [rec("recFD", {
        [F.finalDecisions.email]: "ada@yale.edu",
        [F.finalDecisions.onboarded]: true,
        [F.finalDecisions.status]: "Accepted",
        [F.finalDecisions.department]: "BVHD",
      })],
    }, SOURCE);
    expect(row.furthestStage).toBe("ONBOARDED");
    expect(row.outcome).toBe("ACCEPTED");
    expect(row.resultDepartmentRaw).toBe("BVHD");
  });

  it("marks rows sourced from the Ineligible table as INELIGIBLE", () => {
    const [row] = transformVolunteerFa24({
      ...empty, r1Ineligible: [rec("recI", { [F.r1Ineligible.email]: "no@yale.edu" })],
    }, SOURCE);
    expect(row.outcome).toBe("INELIGIBLE");
  });

  it("emits Non-Yale rows too, since a non-Yale applicant is still demonstrated interest", () => {
    const [row] = transformVolunteerFa24({
      ...empty, nonYale: [rec("recNY", { [F.nonYale.email]: "outside@gmail.com" })],
    }, SOURCE);
    expect(row.identity.email).toBe("outside@gmail.com");
  });

  it("skips rows with no email, which are Airtable cruft", () => {
    expect(transformVolunteerFa24({ ...empty, r1New: [rec("recN", {})] }, SOURCE)).toHaveLength(0);
  });

  it("parses submittedAt from each row's OWN record createdTime, not a shared one", () => {
    // This adapter emits rows from several source tables in one loop; a bug
    // that reused one record's createdTime for every row would pass a
    // single-row test but fail here.
    const rows = transformVolunteerFa24({
      ...empty,
      r1New: [rec("recN", { [F.r1New.email]: "new@yale.edu" }, "2024-09-01T00:00:00.000Z")],
      r1Returning: [rec("recR", { [F.r1Returning.email]: "ret@yale.edu" }, "2024-09-02T00:00:00.000Z")],
    }, SOURCE);
    expect(rows.find((r) => r.source.recordId === "recN")!.submittedAt)
      .toEqual(new Date("2024-09-01T00:00:00.000Z"));
    expect(rows.find((r) => r.source.recordId === "recR")!.submittedAt)
      .toEqual(new Date("2024-09-02T00:00:00.000Z"));
  });

  it("leaves submittedAt null, not an Invalid Date, when createdTime is absent", () => {
    const [row] = transformVolunteerFa24({
      ...empty, r1New: [rec("recN", { [F.r1New.email]: "a@yale.edu" })],
    }, SOURCE);
    expect(row.submittedAt).toBeNull();
  });
});
