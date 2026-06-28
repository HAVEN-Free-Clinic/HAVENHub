import { expect, it } from "vitest";
import { coursesForMember, type AssignableCourse } from "./assignment";

const courses: AssignableCourse[] = [
  { id: "all", isActive: true, assignToAll: true, departmentIds: [], hasPackage: true },
  { id: "srhd", isActive: true, assignToAll: false, departmentIds: ["d-srhd"], hasPackage: true },
  { id: "pharm", isActive: true, assignToAll: false, departmentIds: ["d-pharm"], hasPackage: true },
  { id: "draft", isActive: true, assignToAll: false, departmentIds: [], hasPackage: true },
  { id: "inactive", isActive: false, assignToAll: true, departmentIds: [], hasPackage: true },
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
    { id: "x", isActive: true, assignToAll: false, departmentIds: ["a", "b"], hasPackage: true },
  ];
  expect(coursesForMember({ courses: multi, memberDepartmentIds: ["a", "b"] })).toEqual(["x"]);
});

it("excludes a course with no uploaded package even when assignToAll", () => {
  const list: AssignableCourse[] = [
    { id: "ready", isActive: true, assignToAll: true, departmentIds: [], hasPackage: true },
    { id: "nopackage", isActive: true, assignToAll: true, departmentIds: [], hasPackage: false },
  ];
  const ids = coursesForMember({ courses: list, memberDepartmentIds: [] });
  expect(ids).toContain("ready");
  expect(ids).not.toContain("nopackage");
});

it("excludes a package-less course assigned to the member's department", () => {
  const list: AssignableCourse[] = [
    { id: "nopackage", isActive: true, assignToAll: false, departmentIds: ["d-srhd"], hasPackage: false },
  ];
  expect(coursesForMember({ courses: list, memberDepartmentIds: ["d-srhd"] })).not.toContain("nopackage");
});
