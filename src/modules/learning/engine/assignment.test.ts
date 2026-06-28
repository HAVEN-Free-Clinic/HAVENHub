import { expect, it } from "vitest";
import { coursesForMember, kindMatchesAudience, type AssignableCourse, type MemberMembership } from "./assignment";

const course = (over: Partial<AssignableCourse> & { id: string }): AssignableCourse => ({
  isActive: true,
  assignToAll: false,
  departmentIds: [],
  hasPackage: true,
  audience: "EVERYONE",
  ...over,
});
const vol = (departmentId: string): MemberMembership => ({ departmentId, kind: "VOLUNTEER" });
const dir = (departmentId: string): MemberMembership => ({ departmentId, kind: "DIRECTOR" });

const courses: AssignableCourse[] = [
  course({ id: "all", assignToAll: true }),
  course({ id: "srhd", departmentIds: ["d-srhd"] }),
  course({ id: "pharm", departmentIds: ["d-pharm"] }),
  course({ id: "draft" }),
  course({ id: "inactive", assignToAll: true, isActive: false }),
];

it("includes assignToAll courses for any member", () => {
  expect(coursesForMember({ courses, memberships: [vol("d-pharm")] })).toContain("all");
});

it("includes a course assigned to a department the member belongs to", () => {
  expect(coursesForMember({ courses, memberships: [vol("d-srhd")] })).toContain("srhd");
});

it("excludes courses for departments the member is not in", () => {
  expect(coursesForMember({ courses, memberships: [vol("d-srhd")] })).not.toContain("pharm");
});

it("excludes draft courses (active, no departments, not assignToAll)", () => {
  expect(coursesForMember({ courses, memberships: [vol("d-srhd")] })).not.toContain("draft");
});

it("excludes inactive courses even when assignToAll", () => {
  expect(coursesForMember({ courses, memberships: [vol("d-srhd")] })).not.toContain("inactive");
});

it("returns ids with no duplicates when a course matches multiple departments", () => {
  const multi: AssignableCourse[] = [course({ id: "x", departmentIds: ["a", "b"] })];
  expect(coursesForMember({ courses: multi, memberships: [vol("a"), vol("b")] })).toEqual(["x"]);
});

it("excludes a course with no uploaded package even when assignToAll", () => {
  const list: AssignableCourse[] = [
    course({ id: "ready", assignToAll: true }),
    course({ id: "nopackage", assignToAll: true, hasPackage: false }),
  ];
  const ids = coursesForMember({ courses: list, memberships: [vol("d-any")] });
  expect(ids).toContain("ready");
  expect(ids).not.toContain("nopackage");
});

it("assigns a DIRECTORS course only to a director in the assigned department", () => {
  const list = [course({ id: "dir-srhd", departmentIds: ["d-srhd"], audience: "DIRECTORS" })];
  expect(coursesForMember({ courses: list, memberships: [dir("d-srhd")] })).toEqual(["dir-srhd"]);
  expect(coursesForMember({ courses: list, memberships: [vol("d-srhd")] })).toEqual([]);
});

it("assigns a VOLUNTEERS course only to a volunteer in the assigned department", () => {
  const list = [course({ id: "vol-srhd", departmentIds: ["d-srhd"], audience: "VOLUNTEERS" })];
  expect(coursesForMember({ courses: list, memberships: [vol("d-srhd")] })).toEqual(["vol-srhd"]);
  expect(coursesForMember({ courses: list, memberships: [dir("d-srhd")] })).toEqual([]);
});

it("an assignToAll DIRECTORS course reaches a director in any department", () => {
  const list = [course({ id: "all-dir", assignToAll: true, audience: "DIRECTORS" })];
  expect(coursesForMember({ courses: list, memberships: [dir("d-any")] })).toEqual(["all-dir"]);
  expect(coursesForMember({ courses: list, memberships: [vol("d-any")] })).toEqual([]);
});

it("mixed membership: a dept-A DIRECTORS course skips a volunteer-in-A who directs B", () => {
  const list = [course({ id: "dirA", departmentIds: ["A"], audience: "DIRECTORS" })];
  expect(coursesForMember({ courses: list, memberships: [vol("A"), dir("B")] })).toEqual([]);
});

it("mixed membership: an assignToAll DIRECTORS course reaches someone who directs any dept", () => {
  const list = [course({ id: "allDir", assignToAll: true, audience: "DIRECTORS" })];
  expect(coursesForMember({ courses: list, memberships: [vol("A"), dir("B")] })).toEqual(["allDir"]);
});

it("EVERYONE course reaches both directors and volunteers in the department", () => {
  const list = [course({ id: "evrA", departmentIds: ["A"], audience: "EVERYONE" })];
  expect(coursesForMember({ courses: list, memberships: [vol("A")] })).toEqual(["evrA"]);
  expect(coursesForMember({ courses: list, memberships: [dir("A")] })).toEqual(["evrA"]);
});

it("kindMatchesAudience maps plural audiences to singular kinds", () => {
  expect(kindMatchesAudience("DIRECTOR", "DIRECTORS")).toBe(true);
  expect(kindMatchesAudience("VOLUNTEER", "DIRECTORS")).toBe(false);
  expect(kindMatchesAudience("VOLUNTEER", "EVERYONE")).toBe(true);
});
