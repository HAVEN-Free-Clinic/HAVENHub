import { expect, it } from "vitest";
import {
  DEFAULT_SORT_DIRECTION,
  nextSortDirection,
  parseApplicantSort,
  sortApplicants,
  type SortableApplicant,
} from "./applicant-sort";

const base: SortableApplicant = {
  applicant: { firstName: "Ada", lastName: "Lovelace", email: "ada.lovelace@yale.edu" },
  applicantType: "NEW",
  committeeScores: [],
  routedDepartmentCode: null,
  decision: "PENDING",
  interviews: [],
  acceptances: [],
  departmentChoices: [],
};

function app(overrides: Partial<SortableApplicant>): SortableApplicant {
  return { ...base, ...overrides };
}

/** An applicant identified only by last name, for name-ordering assertions. */
function named(lastName: string): SortableApplicant {
  return app({ applicant: { firstName: "Sam", lastName, email: "sam@yale.edu" } });
}

const lastNames = (apps: SortableApplicant[]) => apps.map((a) => a.applicant.lastName);

it("sorts by last name ascending, then descending", () => {
  const apps = [named("Tracey"), named("Alvarez"), named("Mensah")];
  expect(lastNames(sortApplicants(apps, { key: "name", dir: "asc" }))).toEqual(["Alvarez", "Mensah", "Tracey"]);
  expect(lastNames(sortApplicants(apps, { key: "name", dir: "desc" }))).toEqual(["Tracey", "Mensah", "Alvarez"]);
});

it("breaks a shared last name on first name", () => {
  const a = app({ applicant: { firstName: "Zoe", lastName: "Chen", email: "z@yale.edu" } });
  const b = app({ applicant: { firstName: "Alex", lastName: "Chen", email: "a@yale.edu" } });
  const sorted = sortApplicants([a, b], { key: "name", dir: "asc" });
  expect(sorted.map((s) => s.applicant.firstName)).toEqual(["Alex", "Zoe"]);
});

it("sorts accented names next to their unaccented neighbours", () => {
  // A naive `<` compare puts "Renee" after "Zamora", because U+00E9 > "Z".
  const apps = [named("Zamora"), named("Renée"), named("Reed")];
  expect(lastNames(sortApplicants(apps, { key: "name", dir: "asc" }))).toEqual(["Reed", "Renée", "Zamora"]);
});

it("sorts by email", () => {
  const a = app({ applicant: { firstName: "A", lastName: "A", email: "zoe@yale.edu" } });
  const b = app({ applicant: { firstName: "B", lastName: "B", email: "abe@yale.edu" } });
  const sorted = sortApplicants([a, b], { key: "email", dir: "asc" });
  expect(sorted.map((s) => s.applicant.email)).toEqual(["abe@yale.edu", "zoe@yale.edu"]);
});

it("sorts by applicant type label", () => {
  const apps = [app({ applicantType: "RENEWAL" }), app({ applicantType: "NEW" }), app({ applicantType: "TRANSFER" })];
  const sorted = sortApplicants(apps, { key: "type", dir: "asc" });
  // Labels are New, Renewal, Transfer.
  expect(sorted.map((s) => s.applicantType)).toEqual(["NEW", "RENEWAL", "TRANSFER"]);
});

it("sorts by committee average", () => {
  const apps = [
    app({ applicant: { firstName: "A", lastName: "Low", email: "l@yale.edu" }, committeeScores: [{ score: 2 }] }),
    app({ applicant: { firstName: "B", lastName: "High", email: "h@yale.edu" }, committeeScores: [{ score: 5 }] }),
    app({ applicant: { firstName: "C", lastName: "Mid", email: "m@yale.edu" }, committeeScores: [{ score: 3 }, { score: 4 }] }),
  ];
  expect(lastNames(sortApplicants(apps, { key: "score", dir: "desc" }))).toEqual(["High", "Mid", "Low"]);
  expect(lastNames(sortApplicants(apps, { key: "score", dir: "asc" }))).toEqual(["Low", "Mid", "High"]);
});

it("sinks unscored applicants to the bottom in BOTH directions", () => {
  const apps = [
    app({ applicant: { firstName: "A", lastName: "Unscored", email: "u@yale.edu" }, committeeScores: [] }),
    app({ applicant: { firstName: "B", lastName: "Low", email: "l@yale.edu" }, committeeScores: [{ score: 1 }] }),
    app({ applicant: { firstName: "C", lastName: "High", email: "h@yale.edu" }, committeeScores: [{ score: 5 }] }),
  ];
  // Ascending must surface the genuinely low scorer, not a screenful of blanks.
  expect(lastNames(sortApplicants(apps, { key: "score", dir: "asc" }))).toEqual(["Low", "High", "Unscored"]);
  expect(lastNames(sortApplicants(apps, { key: "score", dir: "desc" }))).toEqual(["High", "Low", "Unscored"]);
});

it("sorts by stage in pipeline order, not alphabetically", () => {
  const awaiting = app({ applicant: { firstName: "A", lastName: "Awaiting", email: "a@yale.edu" } });
  const scoring = app({
    applicant: { firstName: "B", lastName: "Scoring", email: "s@yale.edu" },
    committeeScores: [{ score: 4 }],
  });
  const routed = app({
    applicant: { firstName: "C", lastName: "Routed", email: "r@yale.edu" },
    committeeScores: [{ score: 4 }],
    routedDepartmentCode: "EDUC",
  });
  const decided = app({ applicant: { firstName: "D", lastName: "Decided", email: "d@yale.edu" }, decision: "ACCEPT" });
  const sorted = sortApplicants([decided, routed, awaiting, scoring], { key: "stage", dir: "asc" });
  expect(lastNames(sorted)).toEqual(["Awaiting", "Scoring", "Routed", "Decided"]);
});

it("sorts by decision in precedence order, not alphabetically", () => {
  const accepted = app({
    applicant: { firstName: "A", lastName: "Accepted", email: "a@yale.edu" },
    acceptances: [{ departmentCode: "EDUC" }],
  });
  const waitlisted = app({ applicant: { firstName: "W", lastName: "Waitlisted", email: "w@yale.edu" }, decision: "WAITLIST" });
  const rejected = app({ applicant: { firstName: "R", lastName: "Rejected", email: "r@yale.edu" }, decision: "REJECT" });
  const none = app({ applicant: { firstName: "N", lastName: "None", email: "n@yale.edu" } });
  const sorted = sortApplicants([none, rejected, accepted, waitlisted], { key: "decision", dir: "asc" });
  expect(lastNames(sorted)).toEqual(["Accepted", "Waitlisted", "Rejected", "None"]);
});

it("sorts by ranked department choices", () => {
  const apps = [
    app({ applicant: { firstName: "A", lastName: "Second", email: "s@yale.edu" }, departmentChoices: ["MDIC"] }),
    app({ applicant: { firstName: "B", lastName: "First", email: "f@yale.edu" }, departmentChoices: ["CRAD", "EDUC"] }),
  ];
  expect(lastNames(sortApplicants(apps, { key: "ranked", dir: "asc" }))).toEqual(["First", "Second"]);
});

it("keeps the incoming order for ties, preserving submission recency", () => {
  const newest = app({ applicant: { firstName: "A", lastName: "Newest", email: "n@yale.edu" }, committeeScores: [{ score: 4 }] });
  const older = app({ applicant: { firstName: "B", lastName: "Older", email: "o@yale.edu" }, committeeScores: [{ score: 4 }] });
  const oldest = app({ applicant: { firstName: "C", lastName: "Oldest", email: "x@yale.edu" }, committeeScores: [{ score: 4 }] });
  // Input arrives from the service already ordered submittedAt desc.
  const sorted = sortApplicants([newest, older, oldest], { key: "score", dir: "desc" });
  expect(lastNames(sorted)).toEqual(["Newest", "Older", "Oldest"]);
});

it("does not mutate the input array", () => {
  const apps = [named("Tracey"), named("Alvarez")];
  sortApplicants(apps, { key: "name", dir: "asc" });
  expect(lastNames(apps)).toEqual(["Tracey", "Alvarez"]);
});

it("parses a valid sort and direction", () => {
  expect(parseApplicantSort("score", "desc")).toEqual({ key: "score", dir: "desc" });
  expect(parseApplicantSort("name", "asc")).toEqual({ key: "name", dir: "asc" });
});

it("falls back to the default order for an unknown key or direction", () => {
  expect(parseApplicantSort("nickname", "asc")).toBeNull();
  expect(parseApplicantSort("score", "sideways")).toBeNull();
  expect(parseApplicantSort(undefined, undefined)).toBeNull();
  expect(parseApplicantSort("score", undefined)).toBeNull();
});

it("toggles direction when the active column is clicked again", () => {
  expect(nextSortDirection({ key: "name", dir: "asc" }, "name")).toBe("desc");
  expect(nextSortDirection({ key: "name", dir: "desc" }, "name")).toBe("asc");
});

it("uses the column's default direction when a new column is clicked", () => {
  // Committee avg opens descending: the common intent is "show me the top scorers".
  expect(nextSortDirection(null, "score")).toBe("desc");
  expect(nextSortDirection({ key: "name", dir: "asc" }, "score")).toBe("desc");
  expect(nextSortDirection(null, "name")).toBe("asc");
  expect(DEFAULT_SORT_DIRECTION.score).toBe("desc");
});
