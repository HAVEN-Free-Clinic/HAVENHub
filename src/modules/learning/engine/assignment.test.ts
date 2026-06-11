import { expect, it } from "vitest";
import { coursesForMember, type AssignableCourse } from "./assignment";

const courses: AssignableCourse[] = [
  { id: "all", isActive: true, assignToAll: true, departmentIds: [] },
  { id: "srhd", isActive: true, assignToAll: false, departmentIds: ["d-srhd"] },
  { id: "pharm", isActive: true, assignToAll: false, departmentIds: ["d-pharm"] },
  { id: "draft", isActive: true, assignToAll: false, departmentIds: [] },
  { id: "inactive", isActive: false, assignToAll: true, departmentIds: [] },
];

it("includes assignToAll courses for any member", () => {
  expect(coursesForMember({ courses, memberDepartmentIds: ["d-pharm"] })).toContain("all");
});

it("includes a course assigned to a department the member belongs to", () => {
  expect(coursesForMember({ courses, memberDepartmentIds: ["d-srhd"] })).toContain("srhd");
});

it("excludes courses for departments the member is not in", () => {
  expect(coursesForMember({ courses, memberDepartmentIds: ["d-srhd"] })).not.toContain("pharm");
});

it("excludes draft courses (active, no departments, not assignToAll)", () => {
  expect(coursesForMember({ courses, memberDepartmentIds: ["d-srhd"] })).not.toContain("draft");
});

it("excludes inactive courses even when assignToAll", () => {
  expect(coursesForMember({ courses, memberDepartmentIds: ["d-srhd"] })).not.toContain("inactive");
});

it("returns ids with no duplicates when a course matches multiple departments", () => {
  const multi: AssignableCourse[] = [
    { id: "x", isActive: true, assignToAll: false, departmentIds: ["a", "b"] },
  ];
  expect(coursesForMember({ courses: multi, memberDepartmentIds: ["a", "b"] })).toEqual(["x"]);
});
