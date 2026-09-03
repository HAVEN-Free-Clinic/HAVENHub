import { describe, it, expect } from "vitest";
import {
  applicantDepartments,
  departmentFilterOptions,
  filterApplicantsByDepartment,
} from "./applicant-department";

const app = (routedDepartmentCode: string | null, departmentChoices: string[]) => ({
  routedDepartmentCode,
  departmentChoices,
});

describe("applicantDepartments", () => {
  it("answers for the routed department alone once routed", () => {
    expect(applicantDepartments(app("PCAR", ["SCTP", "JCTP"]))).toEqual(["PCAR"]);
  });

  it("answers for every ranked choice while unrouted", () => {
    expect(applicantDepartments(app(null, ["SCTP", "JCTP"]))).toEqual(["SCTP", "JCTP"]);
  });

  it("answers for nothing when a row carries neither", () => {
    expect(applicantDepartments(app(null, []))).toEqual([]);
  });
});

describe("departmentFilterOptions", () => {
  it("dedupes and sorts the codes present in the roster", () => {
    expect(
      departmentFilterOptions([
        app("PCAR", ["SCTP"]),
        app(null, ["SCTP", "JCTP"]),
        app(null, ["JCTP"]),
      ]),
    ).toEqual(["JCTP", "PCAR", "SCTP"]);
  });

  it("offers the routed department even when nobody ranked it", () => {
    // Routing off the ranked choices is legal, and the routed department's
    // reviewers are exactly the people who need this option.
    expect(departmentFilterOptions([app("PCAR", ["SCTP"])])).toEqual(["PCAR"]);
  });

  it("does not offer a department only a routed row ranked", () => {
    // SCTP will never see this application again, so an SCTP option here would
    // be a dead end.
    expect(departmentFilterOptions([app("PCAR", ["SCTP"])])).not.toContain("SCTP");
  });

  it("is empty for an empty roster", () => {
    expect(departmentFilterOptions([])).toEqual([]);
  });
});

describe("filterApplicantsByDepartment", () => {
  const roster = [
    app("PCAR", ["SCTP"]),
    app(null, ["SCTP", "JCTP"]),
    app("JCTP", ["JCTP"]),
    app(null, []),
  ];

  it("returns the whole roster when no department is selected", () => {
    expect(filterApplicantsByDepartment(roster, null)).toEqual(roster);
  });

  it("keeps routed rows and drops the department they merely ranked", () => {
    expect(filterApplicantsByDepartment(roster, "PCAR")).toEqual([roster[0]]);
    expect(filterApplicantsByDepartment(roster, "SCTP")).toEqual([roster[1]]);
  });

  it("keeps a row matched by either route or rank", () => {
    expect(filterApplicantsByDepartment(roster, "JCTP")).toEqual([roster[1], roster[2]]);
  });

  it("does not mutate the input", () => {
    const before = [...roster];
    filterApplicantsByDepartment(roster, "PCAR");
    expect(roster).toEqual(before);
  });
});
