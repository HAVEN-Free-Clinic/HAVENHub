import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { LearningAuthError, LearningValidationError } from "./errors";
import {
  createCourse,
  updateCourse,
  setCourseAssignment,
  listCourses,
  getCourseForEdit,
  getCourseRecurrenceById,
} from "./courses";

async function seed() {
  const manager = await prisma.person.create({ data: { name: "Mgr", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Learning Admin", grants: { create: [{ permission: "learning.manage_courses" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: manager.id, roleId: role.id } });
  const plain = await prisma.person.create({ data: { name: "Plain", status: "ACTIVE" } });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  return { manager, plain, dept };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("rejects creation without the manage permission", async () => {
  const { plain } = await seed();
  await expect(createCourse({ title: "Intro" }, plain.id)).rejects.toBeInstanceOf(LearningAuthError);
});

it("creates a course and lists it (no package yet)", async () => {
  const { manager } = await seed();
  const course = await createCourse({ title: "Intro" }, manager.id);
  expect(course.title).toBe("Intro");
  const list = await listCourses();
  const row = list.find((c) => c.id === course.id);
  expect(row?.hasPackage).toBe(false);
});

it("rejects a blank title", async () => {
  const { manager } = await seed();
  await expect(createCourse({ title: "  " }, manager.id)).rejects.toBeInstanceOf(LearningValidationError);
});

it("updateCourse with omitted isActive does not reactivate a deactivated course", async () => {
  const { manager } = await seed();
  const course = await createCourse({ title: "Intro", isActive: true }, manager.id);
  await updateCourse(course.id, { title: "Intro", isActive: false }, manager.id);
  const updated = await updateCourse(course.id, { title: "Intro Updated" }, manager.id);
  expect(updated.isActive).toBe(false);
});

it("updateCourse on a missing id throws LearningValidationError", async () => {
  const { manager } = await seed();
  await expect(updateCourse("nope", { title: "Ghost" }, manager.id)).rejects.toBeInstanceOf(LearningValidationError);
});

it("sets department assignment", async () => {
  const { manager, dept } = await seed();
  const course = await createCourse({ title: "Intro" }, manager.id);
  await setCourseAssignment(course.id, { departmentIds: [dept.id], assignToAll: false, audience: "EVERYONE" }, manager.id);
  const edited = await getCourseForEdit(course.id);
  expect(edited!.departments.map((d) => d.departmentId)).toEqual([dept.id]);
});

it("persists the course audience", async () => {
  const { manager, dept } = await seed();
  const course = await createCourse({ title: "Intro" }, manager.id);
  await setCourseAssignment(course.id, { departmentIds: [dept.id], assignToAll: false, audience: "DIRECTORS" }, manager.id);
  const edited = await getCourseForEdit(course.id);
  expect(edited!.audience).toBe("DIRECTORS");
});

it("defaults a new course to ONCE recurrence", async () => {
  const { manager } = await seed();
  const course = await createCourse({ title: "Intro" }, manager.id);
  expect(course.recurrence).toBe("ONCE");
});

it("persists a flip to PER_TERM recurrence", async () => {
  const { manager } = await seed();
  const course = await createCourse({ title: "Intro" }, manager.id);
  const updated = await updateCourse(course.id, { title: "Intro", recurrence: "PER_TERM" }, manager.id);
  expect(updated.recurrence).toBe("PER_TERM");
});

it("updateCourse with omitted recurrence does not revert a course back to ONCE", async () => {
  const { manager } = await seed();
  const course = await createCourse({ title: "Intro" }, manager.id);
  await updateCourse(course.id, { title: "Intro", recurrence: "PER_TERM" }, manager.id);
  const updated = await updateCourse(course.id, { title: "Intro Updated" }, manager.id);
  expect(updated.recurrence).toBe("PER_TERM");
});

it("getCourseRecurrenceById maps recurrence per course id", async () => {
  const { manager } = await seed();
  const once = await createCourse({ title: "Once course" }, manager.id);
  const perTerm = await createCourse({ title: "Per-term course" }, manager.id);
  await updateCourse(perTerm.id, { title: "Per-term course", recurrence: "PER_TERM" }, manager.id);
  const map = await getCourseRecurrenceById([once.id, perTerm.id]);
  expect(map[once.id]).toBe("ONCE");
  expect(map[perTerm.id]).toBe("PER_TERM");
});

it("getCourseRecurrenceById returns an empty map for no ids", async () => {
  const map = await getCourseRecurrenceById([]);
  expect(map).toEqual({});
});
