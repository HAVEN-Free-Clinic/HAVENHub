import { describe, it, expect } from "vitest";
import {
  transformDirector,
  DIRECTOR_FIELDS as F,
  DIRECTOR_DECISION_FIELDS as D,
  DIRECTOR_ACCEPTANCE_FIELDS as A,
} from "./director";

const SOURCE = {
  code: "D-FA25", label: "Fall 2025 Director Recruitment", track: "DIRECTOR" as const,
  termCode: "FA25", baseId: "appvvlDJLmGfN0340", adapter: "director" as const,
  tables: { applications: "tbluFoybFPBjBAXyk", finalDecisions: "tblfw1kjlBc5fULrY" },
};
// D-SU26 genuinely has no Final Decisions table.
const SOURCE_SU26 = {
  ...SOURCE, code: "D-SU26", termCode: "SU26", baseId: "app6MHzSA1yPej2zX",
  tables: { applications: "tbluFoybFPBjBAXyk" },
};
const record = (id: string, fields: Record<string, unknown>) => ({ id, fields });
const only = (applications: ReturnType<typeof record>[]) => ({ applications, finalDecisions: [] });

describe("transformDirector", () => {
  it("reads identity from the director field ids", () => {
    const [row] = transformDirector(only([record("rec1", {
      [F.firstName]: "Ada", [F.lastName]: "Lovelace",
      [F.email]: "ada@yale.edu", [F.netId]: "al123",
    })]), SOURCE);
    expect(row.identity.email).toBe("ada@yale.edu");
    expect(row.identity.netId).toBe("al123");
    expect(row.cycle.track).toBe("DIRECTOR");
  });

  it("derives FINAL_ROUND from an interview link", () => {
    const [row] = transformDirector(only([record("rec1", {
      [F.email]: "a@yale.edu", [F.interviews]: ["recIntv"],
    })]), SOURCE);
    expect(row.furthestStage).toBe("FINAL_ROUND");
  });

  it("derives ONBOARDED from a contract link", () => {
    const [row] = transformDirector(only([record("rec1", {
      [F.email]: "a@yale.edu", [F.interviews]: ["recIntv"], [F.contracts]: ["recCon"],
    })]), SOURCE);
    expect(row.furthestStage).toBe("ONBOARDED");
  });

  it("collects all three department choices in rank order", () => {
    const [row] = transformDirector(only([record("rec1", {
      [F.email]: "a@yale.edu", [F.dept1]: "ITCM", [F.dept2]: "BVHD", [F.dept3]: "SCTP",
    })]), SOURCE);
    expect(row.departmentChoicesRaw).toEqual(["ITCM", "BVHD", "SCTP"]);
  });

  it("reads REJECTED from Final Decisions, joined by email", () => {
    // The whole point of the second table: without it this row would be
    // NO_DECISION and indistinguishable from an undecided applicant.
    const [row] = transformDirector({
      applications: [record("rec1", { [F.email]: "Ada@Yale.edu", [F.interviews]: ["recIntv"] })],
      finalDecisions: [record("recFD", { [D.email]: ["ada@yale.edu"], [D.status]: "Rejected" })],
    }, SOURCE);
    expect(row.furthestStage).toBe("FINAL_ROUND");
    expect(row.outcome).toBe("REJECTED");
  });

  it("reads ACCEPTED and the hired department from Final Decisions", () => {
    const [row] = transformDirector({
      applications: [record("rec1", { [F.email]: "a@yale.edu" })],
      finalDecisions: [record("recFD", {
        [D.email]: ["a@yale.edu"], [D.status]: "Accepted", [D.departmentHire]: "ITCM",
      })],
    }, SOURCE);
    expect(row.outcome).toBe("ACCEPTED");
    expect(row.resultDepartmentRaw).toBe("ITCM");
    expect(row.furthestStage).toBe("ACCEPTED");
  });

  it("reports NO_DECISION when no Final Decisions row matches", () => {
    const [row] = transformDirector({
      applications: [record("rec1", { [F.email]: "a@yale.edu" })],
      finalDecisions: [record("recFD", { [D.email]: ["someone-else@yale.edu"], [D.status]: "Rejected" })],
    }, SOURCE);
    expect(row.outcome).toBe("NO_DECISION");
  });

  it("works when the source has no Final Decisions table at all (D-SU26)", () => {
    const [row] = transformDirector({
      applications: [record("rec1", { [F.email]: "a@yale.edu", [F.contracts]: ["recCon"] })],
    }, SOURCE_SU26);
    expect(row.furthestStage).toBe("ONBOARDED");
    expect(row.outcome).toBe("ACCEPTED");
  });

  it("falls back to the linked-record email when the direct field is empty", () => {
    // Not a hypothetical: 57 of D-SU26's 76 rows look like this, because
    // returning applicants link an existing record instead of retyping.
    // Reading only F.email drops three quarters of that cycle.
    const [row] = transformDirector({
      applications: [record("rec1", { [F.emailFromRecord]: ["linked@yale.edu"] })],
      finalDecisions: [],
    }, SOURCE_SU26);
    expect(row).toBeDefined();
    expect(row.identity.email).toBe("linked@yale.edu");
  });

  it("counts the ALTERNATE contract link, which is the only one D-SU26 uses", () => {
    // Verified: on D-SU26 the primary contracts field is populated on 0 of 76
    // rows and this one on 36. Reading only the primary loses every SU26
    // onboarding.
    const [row] = transformDirector({
      applications: [record("rec1", { [F.email]: "a@yale.edu", [F.contractsAlt]: ["recCon"] })],
    }, SOURCE_SU26);
    expect(row.furthestStage).toBe("ONBOARDED");
    expect(row.outcome).toBe("ACCEPTED");
  });

  it("reads an Acceptances row as an acceptance, joined by email", () => {
    // D-SU26 has no Final Decisions table; its 36 outcomes live here.
    const [row] = transformDirector({
      applications: [record("rec1", { [F.email]: "Ada@Yale.edu" })],
      acceptances: [record("recA", {
        [A.email]: ["ada@yale.edu"], [A.department]: ["ITCM"],
      })],
    }, SOURCE_SU26);
    expect(row.outcome).toBe("ACCEPTED");
    expect(row.resultDepartmentRaw).toBe("ITCM");
    expect(row.furthestStage).toBe("ACCEPTED");
  });

  it("leaves an applicant with no acceptance row undecided", () => {
    const [row] = transformDirector({
      applications: [record("rec1", { [F.email]: "a@yale.edu" })],
      acceptances: [record("recA", { [A.email]: ["other@yale.edu"] })],
    }, SOURCE_SU26);
    expect(row.outcome).toBe("NO_DECISION");
  });

  it("prefers the direct email when both are present", () => {
    const [row] = transformDirector({
      applications: [record("rec1", {
        [F.email]: "direct@yale.edu", [F.emailFromRecord]: ["linked@yale.edu"],
      })],
      finalDecisions: [],
    }, SOURCE_SU26);
    expect(row.identity.email).toBe("direct@yale.edu");
  });

  it("skips contactless rows", () => {
    expect(transformDirector(only([record("rec1", {})]), SOURCE)).toHaveLength(0);
  });
});
