import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { LearningAuthError, LearningValidationError } from "./errors";
import {
  createCourse,
  updateCourse,
  setCourseAssignment,
  addModule,
  updateModule,
  deleteModule,
  reorderModules,
  listCourses,
  getCourseForEdit,
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

it("creates a course and lists it", async () => {
  const { manager } = await seed();
  const course = await createCourse({ title: "Intro" }, manager.id);
  expect(course.title).toBe("Intro");
  const list = await listCourses();
  expect(list.map((c) => c.id)).toContain(course.id);
});

it("rejects a blank title", async () => {
  const { manager } = await seed();
  await expect(createCourse({ title: "  " }, manager.id)).rejects.toBeInstanceOf(LearningValidationError);
});

it("adds modules with auto-incrementing positions", async () => {
  const { manager } = await seed();
  const course = await createCourse({ title: "Intro" }, manager.id);
  const m1 = await addModule(course.id, { title: "Watch", kind: "VIDEO", url: "https://v" }, manager.id);
  const m2 = await addModule(course.id, { title: "Read", kind: "DOCUMENT", url: "https://d" }, manager.id);
  expect(m1.position).toBe(0);
  expect(m2.position).toBe(1);
});

it("rejects a VIDEO module without a url", async () => {
  const { manager } = await seed();
  const course = await createCourse({ title: "Intro" }, manager.id);
  await expect(
    addModule(course.id, { title: "Watch", kind: "VIDEO", url: "" }, manager.id)
  ).rejects.toBeInstanceOf(LearningValidationError);
});

it("rejects a QUIZ module with no questions", async () => {
  const { manager } = await seed();
  const course = await createCourse({ title: "Intro" }, manager.id);
  await expect(
    addModule(course.id, { title: "Quiz", kind: "QUIZ", questions: [] }, manager.id)
  ).rejects.toBeInstanceOf(LearningValidationError);
});

it("reorders modules", async () => {
  const { manager } = await seed();
  const course = await createCourse({ title: "Intro" }, manager.id);
  const a = await addModule(course.id, { title: "A", kind: "VIDEO", url: "https://a" }, manager.id);
  const b = await addModule(course.id, { title: "B", kind: "VIDEO", url: "https://b" }, manager.id);
  await reorderModules(course.id, [b.id, a.id], manager.id);
  const edited = await getCourseForEdit(course.id);
  expect(edited!.modules.map((m) => m.id)).toEqual([b.id, a.id]);
});

it("sets department assignment", async () => {
  const { manager, dept } = await seed();
  const course = await createCourse({ title: "Intro" }, manager.id);
  await setCourseAssignment(course.id, { departmentIds: [dept.id], assignToAll: false }, manager.id);
  const edited = await getCourseForEdit(course.id);
  expect(edited!.departments.map((d) => d.departmentId)).toEqual([dept.id]);
});

// --- new tests for hardened behavior ---

it("updateCourse with omitted isActive does not reactivate a deactivated course", async () => {
  const { manager } = await seed();
  const course = await createCourse({ title: "Intro", isActive: true }, manager.id);
  // Explicitly deactivate
  await updateCourse(course.id, { title: "Intro", isActive: false }, manager.id);
  // Now update title only — isActive is omitted
  const updated = await updateCourse(course.id, { title: "Intro Updated" }, manager.id);
  expect(updated.isActive).toBe(false);
});

it("updateCourse on a missing id throws LearningValidationError", async () => {
  const { manager } = await seed();
  await expect(
    updateCourse("nonexistent-id", { title: "Ghost" }, manager.id)
  ).rejects.toBeInstanceOf(LearningValidationError);
});

it("updateModule on a missing id throws LearningValidationError", async () => {
  const { manager } = await seed();
  await expect(
    updateModule("nonexistent-id", { title: "Ghost", kind: "VIDEO", url: "https://x" }, manager.id)
  ).rejects.toBeInstanceOf(LearningValidationError);
});

it("deleteModule on a missing id throws LearningValidationError", async () => {
  const { manager } = await seed();
  await expect(
    deleteModule("nonexistent-id", manager.id)
  ).rejects.toBeInstanceOf(LearningValidationError);
});

it("reorderModules with an id from a different course throws LearningValidationError", async () => {
  const { manager } = await seed();
  const courseA = await createCourse({ title: "Course A" }, manager.id);
  const courseB = await createCourse({ title: "Course B" }, manager.id);
  const a = await addModule(courseA.id, { title: "A", kind: "VIDEO", url: "https://a" }, manager.id);
  const b = await addModule(courseB.id, { title: "B", kind: "VIDEO", url: "https://b" }, manager.id);
  // Pass module from courseB when reordering courseA
  await expect(
    reorderModules(courseA.id, [a.id, b.id], manager.id)
  ).rejects.toBeInstanceOf(LearningValidationError);
});

it("rejects a non-integer passPercent for QUIZ modules", async () => {
  const { manager } = await seed();
  const course = await createCourse({ title: "Intro" }, manager.id);
  await expect(
    addModule(
      course.id,
      {
        title: "Quiz",
        kind: "QUIZ",
        questions: [{ key: "q1", label: "Q?", options: [{ value: "a", label: "A" }], correctValue: "a" }],
        passPercent: 75.5,
      },
      manager.id
    )
  ).rejects.toBeInstanceOf(LearningValidationError);
});

it("rejects a non-integer maxAttempts for QUIZ modules", async () => {
  const { manager } = await seed();
  const course = await createCourse({ title: "Intro" }, manager.id);
  await expect(
    addModule(
      course.id,
      {
        title: "Quiz",
        kind: "QUIZ",
        questions: [{ key: "q1", label: "Q?", options: [{ value: "a", label: "A" }], correctValue: "a" }],
        maxAttempts: 2.5,
      },
      manager.id
    )
  ).rejects.toBeInstanceOf(LearningValidationError);
});
