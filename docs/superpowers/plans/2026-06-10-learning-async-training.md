# Learning — Asynchronous Training Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native `learning` module that delivers department-assigned, self-paced courses (external video/document links + native quizzes) with per-volunteer progress, quiz pass control, and a per-department completion dashboard.

**Architecture:** A new module registered in `src/platform/modules/registry.ts`, following the `recruitment` pattern: pure logic in `src/modules/learning/engine/`, DB-backed services in `src/modules/learning/services/`, and App Router routes in `src/app/learning/`. Quizzes reuse the existing `gradeQuiz` grader (lifted to a shared `src/platform/quiz/` location). Assignment is computed from `TermMembership` for the active term. No SCORM, no certificates, no sequential gating in v1.

**Tech Stack:** Next.js 16 (App Router, Server Components + Server Actions), Prisma 6 / Postgres (Neon), NextAuth v5, Vitest, Tailwind v4. Reuses `@/platform/db`, `@/platform/rbac/engine` (`can`), `@/platform/audit` (`recordAudit`), `@/platform/auth/session`, `@/platform/settings`, `@/platform/ui`.

**Spec:** `docs/superpowers/specs/2026-06-10-learning-async-training-design.md`

---

## File Structure

**Created:**
- `src/modules/learning/engine/assignment.ts` — pure: which active courses a member is assigned.
- `src/modules/learning/engine/assignment.test.ts`
- `src/modules/learning/engine/completion.ts` — pure: course-complete + progress counts from module states.
- `src/modules/learning/engine/completion.test.ts`
- `src/modules/learning/services/errors.ts` — `LearningAuthError`, `LearningValidationError`.
- `src/modules/learning/services/courses.ts` — management (CRUD courses/modules/assignment).
- `src/modules/learning/services/courses.test.ts`
- `src/modules/learning/services/enrollment.ts` — learner reads + progress writes.
- `src/modules/learning/services/enrollment.test.ts`
- `src/modules/learning/services/dashboard.ts` — completion dashboard + quiz reset.
- `src/modules/learning/services/dashboard.test.ts`
- `src/modules/learning/services/types.ts` — shared `QuizQuestion` and view types.
- `src/platform/quiz/grading.ts` — `gradeQuiz` (moved from recruitment).
- `src/platform/quiz/grading.test.ts` — (moved from recruitment).
- `src/app/learning/page.tsx` — learner course list.
- `src/app/learning/actions.ts` — learner server actions.
- `src/app/learning/[courseId]/page.tsx` — learner course detail.
- `src/app/learning/manage/page.tsx` — course management list.
- `src/app/learning/manage/actions.ts` — management server actions.
- `src/app/learning/manage/[courseId]/page.tsx` — single-course editor.
- `src/app/learning/dashboard/page.tsx` — completion dashboard.
- `src/app/learning/dashboard/actions.ts` — quiz-reset action.

**Modified:**
- `prisma/schema.prisma` — new models/enums + back-relations on `Person`, `Department`, `Term`.
- `src/platform/test/db.ts` — add new tables to the `TRUNCATE` list.
- `src/platform/settings/registry.ts` — two default-quiz settings.
- `src/platform/modules/registry.ts` — `learning` manifest.
- `src/modules/recruitment/engine/quiz-grading.ts` — re-export from the new shared location.
- `src/modules/recruitment/services/training.ts` — import `gradeQuiz` from `@/platform/quiz/grading`.

---

## Task 1: Shared quiz grader extraction

Lift the pure grader out of `recruitment` so `learning` does not import recruitment internals. Behavior is identical; this is a move + re-point.

**Files:**
- Create: `src/platform/quiz/grading.ts`
- Create: `src/platform/quiz/grading.test.ts`
- Modify: `src/modules/recruitment/engine/quiz-grading.ts`
- Modify: `src/modules/recruitment/services/training.ts:8` (import line)

- [ ] **Step 1: Create the shared grader (copy of the existing implementation)**

Create `src/platform/quiz/grading.ts`:

```typescript
/** Pure quiz grader. No DB, no side effects. A question with correctValue == null
 *  is non-graded (excluded from the total). A quiz with no graded questions can
 *  never pass, so an unfinished quiz never clears a volunteer. */

export type GradedQuestion = { key: string; correctValue: string | null };

export type QuizResult = {
  score: number;
  total: number;
  percent: number;
  passed: boolean;
};

export function gradeQuiz(
  questions: GradedQuestion[],
  answers: Record<string, unknown>,
  passPercent: number
): QuizResult {
  const graded = questions.filter((q) => q.correctValue !== null);
  const total = graded.length;
  let score = 0;
  for (const q of graded) {
    if (answers[q.key] === q.correctValue) score += 1;
  }
  const percent = total === 0 ? 0 : Math.round((100 * score) / total);
  const passed = total > 0 && percent >= passPercent;
  return { score, total, percent, passed };
}
```

- [ ] **Step 2: Move the existing grader test to the new location**

Run: `git mv src/modules/recruitment/engine/quiz-grading.test.ts src/platform/quiz/grading.test.ts`

Then edit the import at the top of `src/platform/quiz/grading.test.ts` to point at the sibling file:

```typescript
import { gradeQuiz } from "./grading";
```

(Leave the test bodies unchanged.)

- [ ] **Step 3: Replace the recruitment engine file with a re-export**

Replace the entire contents of `src/modules/recruitment/engine/quiz-grading.ts` with:

```typescript
/** Re-export of the shared grader. The implementation moved to
 *  @/platform/quiz/grading so non-recruitment modules can use it without
 *  reaching into recruitment internals. */
export { gradeQuiz } from "@/platform/quiz/grading";
export type { GradedQuestion, QuizResult } from "@/platform/quiz/grading";
```

- [ ] **Step 4: Run the moved test to verify it passes**

Run: `npx vitest run src/platform/quiz/grading.test.ts`
Expected: PASS (all existing grader cases green).

- [ ] **Step 5: Run the recruitment training test to verify nothing broke**

Run: `npx vitest run src/modules/recruitment/services/training.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/platform/quiz src/modules/recruitment/engine/quiz-grading.ts
git commit -m "refactor: lift gradeQuiz to shared @/platform/quiz/grading"
```

---

## Task 2: Prisma schema — Learning models

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/platform/test/db.ts`

- [ ] **Step 1: Add enums and models**

Append to `prisma/schema.prisma`:

```prisma
enum CourseModuleKind {
  VIDEO
  DOCUMENT
  QUIZ
}

enum CourseProgressStatus {
  IN_PROGRESS
  COMPLETE
}

model Course {
  id          String             @id @default(cuid())
  title       String
  description String?
  isActive    Boolean            @default(true)
  /// When true, the course is assigned to every department (org-wide).
  assignToAll Boolean            @default(false)
  /// Ordering in the catalog / management list.
  position    Int                @default(0)
  createdAt   DateTime           @default(now())
  updatedAt   DateTime           @updatedAt
  modules     CourseModule[]
  departments CourseDepartment[]
  progress    CourseProgress[]
}

model CourseDepartment {
  id           String     @id @default(cuid())
  courseId     String
  departmentId String
  course       Course     @relation(fields: [courseId], references: [id], onDelete: Cascade)
  department   Department @relation(fields: [departmentId], references: [id], onDelete: Cascade)

  @@unique([courseId, departmentId])
  @@index([departmentId])
}

model CourseModule {
  id          String           @id @default(cuid())
  courseId    String
  position    Int
  title       String
  kind        CourseModuleKind
  /// Instructions shown to the volunteer (optional).
  description String?
  /// External link for VIDEO / DOCUMENT modules.
  url         String?
  /// QUIZ only: array of { key, label, options:[{value,label}], correctValue }.
  questions   Json?
  /// QUIZ only: override; null means use the learning.defaultQuizPassPercent setting.
  passPercent Int?
  /// QUIZ only: override; null means use the learning.defaultQuizMaxAttempts setting.
  maxAttempts Int?
  course      Course           @relation(fields: [courseId], references: [id], onDelete: Cascade)
  progress    ModuleProgress[]

  @@unique([courseId, position])
}

model CourseProgress {
  id          String               @id @default(cuid())
  personId    String
  courseId    String
  status      CourseProgressStatus @default(IN_PROGRESS)
  completedAt DateTime?
  person      Person               @relation(fields: [personId], references: [id], onDelete: Cascade)
  course      Course               @relation(fields: [courseId], references: [id], onDelete: Cascade)

  @@unique([personId, courseId])
  @@index([courseId])
}

model ModuleProgress {
  id          String              @id @default(cuid())
  personId    String
  moduleId    String
  completedAt DateTime?
  /// Quiz attempt lock (cap reached without a pass).
  locked      Boolean             @default(false)
  /// Opens a fresh attempt window after a manager reset; attempts before this
  /// timestamp do not count toward the cap.
  lockResetAt DateTime?
  person      Person              @relation(fields: [personId], references: [id], onDelete: Cascade)
  module      CourseModule        @relation(fields: [moduleId], references: [id], onDelete: Cascade)
  attempts    CourseQuizAttempt[]

  @@unique([personId, moduleId])
  @@index([moduleId])
}

model CourseQuizAttempt {
  id               String         @id @default(cuid())
  moduleProgressId String
  answers          Json
  score            Int
  total            Int
  passed           Boolean
  takenAt          DateTime       @default(now())
  moduleProgress   ModuleProgress @relation(fields: [moduleProgressId], references: [id], onDelete: Cascade)

  @@index([moduleProgressId, takenAt])
}
```

- [ ] **Step 2: Add back-relations to existing models**

In `prisma/schema.prisma`, inside `model Person { ... }`, add these two relation fields (next to the other relation lists such as `memberships`):

```prisma
  courseProgress      CourseProgress[]
  moduleProgress      ModuleProgress[]
```

Inside `model Department { ... }`, add (next to `shiftAssignments`):

```prisma
  courseDepartments          CourseDepartment[]
```

(No change needed to `model Term` — courses are not term-scoped.)

- [ ] **Step 3: Format and create the migration**

Run:
```bash
npx prisma format
npx prisma migrate dev --name learning_module
```
Expected: a new migration under `prisma/migrations/`, and `prisma generate` runs. If the dev DB is not up, start it first: `docker compose up -d postgres` and ensure `DATABASE_URL` points at it.

- [ ] **Step 4: Add the new tables to the test truncation list**

In `src/platform/test/db.ts`, extend the `TRUNCATE` statement. Replace the line beginning `TRUNCATE "QuizAttempt", "VolunteerTraining",` so the new tables are included at the front:

```typescript
    `TRUNCATE "CourseQuizAttempt", "ModuleProgress", "CourseProgress", "CourseDepartment", "CourseModule", "Course",
              "QuizAttempt", "VolunteerTraining", "Evaluation", "InterviewPanelist", "Interview", "OnboardingContract", "Acceptance", "Application", "Applicant", "FormField", "FormSection", "RecruitmentCycle",
              "ShiftRequest", "ScheduleDay", "RhdClinic", "RhdAttending",
              "ShiftAssignment", "HipaaCertificate", "RoleAssignment", "RoleGrant", "Role", "TermMembership",
              "DepartmentDelegation", "Department", "Term", "Person", "AuditLog",
              "Outbox", "MirrorRecord", "WorkerHeartbeat",
              "OffboardFlag", "EpicRequest", "YnhhTicket", "DisciplinaryAction", "EmailLog", "EmailCampaignRun", "EmailCampaign", "EmailTemplate",
              "ComplianceReminder", "MailCredential", "Setting" CASCADE`
```

- [ ] **Step 5: Typecheck (confirms the generated client picked up the models)**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/platform/test/db.ts
git commit -m "feat: add Learning module Prisma models and migration"
```

---

## Task 3: Default quiz settings

Two configurable defaults used when a quiz module does not override them.

**Files:**
- Modify: `src/platform/settings/registry.ts`

- [ ] **Step 1: Add the settings definitions**

In `src/platform/settings/registry.ts`, add these two entries to the `SETTINGS` array (after the existing `Operations` entries). The `define<number>` helper and `z` import already exist in this file.

```typescript
  define<number>({
    key: "learning.defaultQuizPassPercent",
    category: "Operations",
    label: "Default course quiz pass %",
    help: "Default passing score for a course quiz when the quiz has no override.",
    input: { type: "number", min: 0, max: 100 },
    schema: z.number().int().min(0).max(100),
    envDefault: () => 80,
    secret: false,
  }),
  define<number>({
    key: "learning.defaultQuizMaxAttempts",
    category: "Operations",
    label: "Default course quiz attempts",
    help: "Default number of attempts on a course quiz before it locks, when the quiz has no override.",
    input: { type: "number", min: 1 },
    schema: z.number().int().positive(),
    envDefault: () => 3,
    secret: false,
  }),
```

- [ ] **Step 2: Verify the registry test still passes**

Run: `npx vitest run src/platform/settings/registry.test.ts`
Expected: PASS.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/platform/settings/registry.ts
git commit -m "feat: add default course-quiz settings"
```

---

## Task 4: Engine — assignment resolution (pure)

**Files:**
- Create: `src/modules/learning/engine/assignment.ts`
- Create: `src/modules/learning/engine/assignment.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/learning/engine/assignment.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/learning/engine/assignment.test.ts`
Expected: FAIL with "Cannot find module './assignment'".

- [ ] **Step 3: Write the implementation**

Create `src/modules/learning/engine/assignment.ts`:

```typescript
/** Pure assignment resolution. No DB. A member is assigned an active course
 *  when it is org-wide (assignToAll) or assigned to a department they belong to.
 *  A course that is active but has no departments and is not assignToAll is a
 *  draft and is assigned to no one. */

export type AssignableCourse = {
  id: string;
  isActive: boolean;
  assignToAll: boolean;
  departmentIds: string[];
};

export function coursesForMember(params: {
  courses: AssignableCourse[];
  memberDepartmentIds: string[];
}): string[] {
  const memberDepts = new Set(params.memberDepartmentIds);
  const out: string[] = [];
  for (const course of params.courses) {
    if (!course.isActive) continue;
    const assigned =
      course.assignToAll || course.departmentIds.some((d) => memberDepts.has(d));
    if (assigned) out.push(course.id);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/learning/engine/assignment.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/learning/engine/assignment.ts src/modules/learning/engine/assignment.test.ts
git commit -m "feat: add Learning assignment resolution engine"
```

---

## Task 5: Engine — completion + progress counts (pure)

**Files:**
- Create: `src/modules/learning/engine/completion.ts`
- Create: `src/modules/learning/engine/completion.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/learning/engine/completion.test.ts`:

```typescript
import { expect, it } from "vitest";
import { isCourseComplete, progressCounts, type ModuleState } from "./completion";

const done = (kind: ModuleState["kind"]): ModuleState =>
  kind === "QUIZ" ? { kind, completed: false, quizPassed: true } : { kind, completed: true, quizPassed: false };
const notDone = (kind: ModuleState["kind"]): ModuleState => ({ kind, completed: false, quizPassed: false });

it("a video/document module is done when completed", () => {
  expect(isCourseComplete([done("VIDEO"), done("DOCUMENT")])).toBe(true);
});

it("a quiz module is done only when passed (completed flag is ignored for quizzes)", () => {
  expect(isCourseComplete([{ kind: "QUIZ", completed: true, quizPassed: false }])).toBe(false);
  expect(isCourseComplete([{ kind: "QUIZ", completed: false, quizPassed: true }])).toBe(true);
});

it("course is incomplete if any module is not done", () => {
  expect(isCourseComplete([done("VIDEO"), notDone("QUIZ")])).toBe(false);
});

it("an empty course is not complete", () => {
  expect(isCourseComplete([])).toBe(false);
});

it("progressCounts reports done / total", () => {
  expect(progressCounts([done("VIDEO"), notDone("DOCUMENT"), done("QUIZ")])).toEqual({ done: 2, total: 3 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/learning/engine/completion.test.ts`
Expected: FAIL with "Cannot find module './completion'".

- [ ] **Step 3: Write the implementation**

Create `src/modules/learning/engine/completion.ts`:

```typescript
import type { CourseModuleKind } from "@prisma/client";

/** The state of one module for one learner. For VIDEO/DOCUMENT, `completed`
 *  drives doneness; for QUIZ, `quizPassed` does. */
export type ModuleState = {
  kind: CourseModuleKind;
  completed: boolean;
  quizPassed: boolean;
};

function isModuleDone(m: ModuleState): boolean {
  return m.kind === "QUIZ" ? m.quizPassed : m.completed;
}

/** A course is complete when it has at least one module and every module is done. */
export function isCourseComplete(modules: ModuleState[]): boolean {
  return modules.length > 0 && modules.every(isModuleDone);
}

/** Done vs total module counts, for the learner's progress label. */
export function progressCounts(modules: ModuleState[]): { done: number; total: number } {
  return { done: modules.filter(isModuleDone).length, total: modules.length };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/learning/engine/completion.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/learning/engine/completion.ts src/modules/learning/engine/completion.test.ts
git commit -m "feat: add Learning completion engine"
```

---

## Task 6: Service types and errors

**Files:**
- Create: `src/modules/learning/services/errors.ts`
- Create: `src/modules/learning/services/types.ts`

- [ ] **Step 1: Create the error classes**

Create `src/modules/learning/services/errors.ts`:

```typescript
export class LearningAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearningAuthError";
  }
}

export class LearningValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearningValidationError";
  }
}
```

- [ ] **Step 2: Create the shared types**

Create `src/modules/learning/services/types.ts`:

```typescript
/** One quiz question as stored in CourseModule.questions (JSON). The grader
 *  consumes only { key, correctValue }; label/options are for rendering. A null
 *  correctValue marks a non-graded question. */
export type QuizQuestion = {
  key: string;
  label: string;
  options: { value: string; label: string }[];
  correctValue: string | null;
};

/** Parse the JSON column into typed questions; returns [] for null/invalid. */
export function parseQuizQuestions(value: unknown): QuizQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (q): q is QuizQuestion =>
      !!q &&
      typeof q === "object" &&
      typeof (q as QuizQuestion).key === "string" &&
      typeof (q as QuizQuestion).label === "string" &&
      Array.isArray((q as QuizQuestion).options)
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/modules/learning/services/errors.ts src/modules/learning/services/types.ts
git commit -m "feat: add Learning service errors and types"
```

---

## Task 7: Service — course management (CRUD)

Management functions for authoring. All mutations require `learning.manage_courses` and write to `AuditLog`.

**Files:**
- Create: `src/modules/learning/services/courses.ts`
- Create: `src/modules/learning/services/courses.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/learning/services/courses.test.ts`:

```typescript
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { LearningAuthError, LearningValidationError } from "./errors";
import {
  createCourse,
  updateCourse,
  setCourseAssignment,
  addModule,
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/learning/services/courses.test.ts`
Expected: FAIL with "Cannot find module './courses'".

- [ ] **Step 3: Write the implementation**

Create `src/modules/learning/services/courses.ts`:

```typescript
import type { Course, CourseModule, CourseModuleKind, Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { LearningAuthError, LearningValidationError } from "./errors";
import { parseQuizQuestions, type QuizQuestion } from "./types";

async function requireManager(actorId: string): Promise<void> {
  if (!(await can(actorId, "learning.manage_courses"))) {
    throw new LearningAuthError("You do not have permission to manage courses.");
  }
}

export type CourseInput = {
  title: string;
  description?: string | null;
  isActive?: boolean;
};

export async function createCourse(input: CourseInput, actorId: string): Promise<Course> {
  await requireManager(actorId);
  const title = input.title.trim();
  if (!title) throw new LearningValidationError("Course title is required.");
  const max = await prisma.course.aggregate({ _max: { position: true } });
  const course = await prisma.course.create({
    data: {
      title,
      description: input.description?.trim() || null,
      isActive: input.isActive ?? true,
      position: (max._max.position ?? -1) + 1,
    },
  });
  await recordAudit({ actorPersonId: actorId, action: "learning.course_create", entityType: "Course", entityId: course.id, after: { title } });
  return course;
}

export async function updateCourse(id: string, input: CourseInput, actorId: string): Promise<Course> {
  await requireManager(actorId);
  const title = input.title.trim();
  if (!title) throw new LearningValidationError("Course title is required.");
  const course = await prisma.course.update({
    where: { id },
    data: { title, description: input.description?.trim() || null, isActive: input.isActive ?? true },
  });
  await recordAudit({ actorPersonId: actorId, action: "learning.course_update", entityType: "Course", entityId: id, after: { title, isActive: course.isActive } });
  return course;
}

export async function setCourseAssignment(
  courseId: string,
  input: { departmentIds: string[]; assignToAll: boolean },
  actorId: string
): Promise<void> {
  await requireManager(actorId);
  await prisma.$transaction(async (tx) => {
    await tx.course.update({ where: { id: courseId }, data: { assignToAll: input.assignToAll } });
    await tx.courseDepartment.deleteMany({ where: { courseId } });
    if (input.departmentIds.length > 0) {
      await tx.courseDepartment.createMany({
        data: input.departmentIds.map((departmentId) => ({ courseId, departmentId })),
        skipDuplicates: true,
      });
    }
  });
  await recordAudit({ actorPersonId: actorId, action: "learning.course_assign", entityType: "Course", entityId: courseId, after: input });
}

export type ModuleInput = {
  title: string;
  kind: CourseModuleKind;
  description?: string | null;
  url?: string | null;
  questions?: QuizQuestion[];
  passPercent?: number | null;
  maxAttempts?: number | null;
};

function validateModule(input: ModuleInput): void {
  if (!input.title.trim()) throw new LearningValidationError("Module title is required.");
  if (input.kind === "VIDEO" || input.kind === "DOCUMENT") {
    if (!input.url || !input.url.trim()) {
      throw new LearningValidationError("A video or document module needs a link.");
    }
  }
  if (input.kind === "QUIZ") {
    const qs = input.questions ?? [];
    if (qs.length === 0) throw new LearningValidationError("A quiz module needs at least one question.");
    if (input.passPercent != null && (input.passPercent < 0 || input.passPercent > 100)) {
      throw new LearningValidationError("Pass percent must be between 0 and 100.");
    }
    if (input.maxAttempts != null && input.maxAttempts < 1) {
      throw new LearningValidationError("Max attempts must be at least 1.");
    }
  }
}

function moduleData(input: ModuleInput): Prisma.CourseModuleUncheckedCreateInput | Prisma.CourseModuleUpdateInput {
  const isQuiz = input.kind === "QUIZ";
  return {
    title: input.title.trim(),
    kind: input.kind,
    description: input.description?.trim() || null,
    url: isQuiz ? null : input.url!.trim(),
    questions: isQuiz ? ((input.questions ?? []) as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
    passPercent: isQuiz ? input.passPercent ?? null : null,
    maxAttempts: isQuiz ? input.maxAttempts ?? null : null,
  };
}

export async function addModule(courseId: string, input: ModuleInput, actorId: string): Promise<CourseModule> {
  await requireManager(actorId);
  validateModule(input);
  const max = await prisma.courseModule.aggregate({ where: { courseId }, _max: { position: true } });
  const created = await prisma.courseModule.create({
    data: { courseId, position: (max._max.position ?? -1) + 1, ...(moduleData(input) as Prisma.CourseModuleUncheckedCreateInput) },
  });
  await recordAudit({ actorPersonId: actorId, action: "learning.module_create", entityType: "CourseModule", entityId: created.id, after: { courseId, title: created.title, kind: created.kind } });
  return created;
}

export async function updateModule(id: string, input: ModuleInput, actorId: string): Promise<CourseModule> {
  await requireManager(actorId);
  validateModule(input);
  const updated = await prisma.courseModule.update({ where: { id }, data: moduleData(input) as Prisma.CourseModuleUpdateInput });
  await recordAudit({ actorPersonId: actorId, action: "learning.module_update", entityType: "CourseModule", entityId: id, after: { title: updated.title, kind: updated.kind } });
  return updated;
}

export async function deleteModule(id: string, actorId: string): Promise<void> {
  await requireManager(actorId);
  await prisma.courseModule.delete({ where: { id } });
  await recordAudit({ actorPersonId: actorId, action: "learning.module_delete", entityType: "CourseModule", entityId: id });
}

/** Persist a new module order. Writes positions in two passes to dodge the
 *  @@unique([courseId, position]) constraint during the shuffle. */
export async function reorderModules(courseId: string, orderedIds: string[], actorId: string): Promise<void> {
  await requireManager(actorId);
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx.courseModule.update({ where: { id: orderedIds[i] }, data: { position: 1000 + i } });
    }
    for (let i = 0; i < orderedIds.length; i++) {
      await tx.courseModule.update({ where: { id: orderedIds[i] }, data: { position: i } });
    }
  });
  await recordAudit({ actorPersonId: actorId, action: "learning.module_reorder", entityType: "Course", entityId: courseId });
}

export type CourseListRow = { id: string; title: string; isActive: boolean; moduleCount: number; assignToAll: boolean };

export async function listCourses(): Promise<CourseListRow[]> {
  const courses = await prisma.course.findMany({
    orderBy: { position: "asc" },
    include: { _count: { select: { modules: true } } },
  });
  return courses.map((c) => ({ id: c.id, title: c.title, isActive: c.isActive, assignToAll: c.assignToAll, moduleCount: c._count.modules }));
}

export async function getCourseForEdit(id: string) {
  const course = await prisma.course.findUnique({
    where: { id },
    include: { modules: { orderBy: { position: "asc" } }, departments: true },
  });
  if (!course) return null;
  return {
    ...course,
    modules: course.modules.map((m) => ({ ...m, questions: parseQuizQuestions(m.questions) })),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/learning/services/courses.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/learning/services/courses.ts src/modules/learning/services/courses.test.ts
git commit -m "feat: add Learning course management service"
```

---

## Task 8: Service — learner enrollment and progress

Reads the learner's assigned courses, and writes progress: mark a video/document done, submit a quiz (grade, lock on cap, recompute course completion).

**Files:**
- Create: `src/modules/learning/services/enrollment.ts`
- Create: `src/modules/learning/services/enrollment.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/learning/services/enrollment.test.ts`:

```typescript
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { LearningAuthError, LearningValidationError } from "./errors";
import { getMyCourses, getCourseForLearner, markModuleComplete, submitCourseQuiz } from "./enrollment";
import type { QuizQuestion } from "./types";

const QUESTIONS: QuizQuestion[] = [
  { key: "q1", label: "2+2?", options: [{ value: "4", label: "4" }, { value: "5", label: "5" }], correctValue: "4" },
];

async function seed() {
  const term = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const other = await prisma.department.create({ data: { code: "PHARM", name: "Pharmacy" } });
  const person = await prisma.person.create({ data: { name: "Vol", status: "ACTIVE" } });
  await prisma.termMembership.create({ data: { personId: person.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });

  const course = await prisma.course.create({ data: { title: "Intro", isActive: true } });
  await prisma.courseDepartment.create({ data: { courseId: course.id, departmentId: dept.id } });
  const video = await prisma.courseModule.create({ data: { courseId: course.id, position: 0, title: "Watch", kind: "VIDEO", url: "https://v" } });
  const quiz = await prisma.courseModule.create({ data: { courseId: course.id, position: 1, title: "Quiz", kind: "QUIZ", questions: QUESTIONS as object, passPercent: 100, maxAttempts: 2 } });

  // A course assigned to a department the person is NOT in.
  const hidden = await prisma.course.create({ data: { title: "Hidden", isActive: true } });
  await prisma.courseDepartment.create({ data: { courseId: hidden.id, departmentId: other.id } });

  return { person, course, video, quiz, hidden };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("lists only assigned courses with progress counts", async () => {
  const { person, course, hidden } = await seed();
  const mine = await getMyCourses(person.id);
  const ids = mine.map((c) => c.id);
  expect(ids).toContain(course.id);
  expect(ids).not.toContain(hidden.id);
  const intro = mine.find((c) => c.id === course.id)!;
  expect(intro).toMatchObject({ done: 0, total: 2, status: "IN_PROGRESS" });
});

it("blocks reading a course that is not assigned to the learner", async () => {
  const { person, hidden } = await seed();
  await expect(getCourseForLearner(person.id, hidden.id)).rejects.toBeInstanceOf(LearningAuthError);
});

it("marks a video module complete", async () => {
  const { person, video } = await seed();
  await markModuleComplete(person.id, video.id);
  const detail = await getCourseForLearner(person.id, (await prisma.courseModule.findUniqueOrThrow({ where: { id: video.id } })).courseId);
  expect(detail.modules.find((m) => m.id === video.id)!.completed).toBe(true);
});

it("refuses to mark a quiz module complete via markModuleComplete", async () => {
  const { person, quiz } = await seed();
  await expect(markModuleComplete(person.id, quiz.id)).rejects.toBeInstanceOf(LearningValidationError);
});

it("passing the quiz after completing the video completes the course", async () => {
  const { person, course, video, quiz } = await seed();
  await markModuleComplete(person.id, video.id);
  const res = await submitCourseQuiz(person.id, quiz.id, { q1: "4" });
  expect(res.passed).toBe(true);
  const progress = await prisma.courseProgress.findUniqueOrThrow({ where: { personId_courseId: { personId: person.id, courseId: course.id } } });
  expect(progress.status).toBe("COMPLETE");
});

it("locks the quiz after the attempt cap without a pass", async () => {
  const { person, quiz } = await seed();
  await submitCourseQuiz(person.id, quiz.id, { q1: "5" }); // attempt 1 (cap 2)
  await submitCourseQuiz(person.id, quiz.id, { q1: "5" }); // attempt 2 -> lock
  const mp = await prisma.moduleProgress.findUniqueOrThrow({ where: { personId_moduleId: { personId: person.id, moduleId: quiz.id } } });
  expect(mp.locked).toBe(true);
  await expect(submitCourseQuiz(person.id, quiz.id, { q1: "4" })).rejects.toBeInstanceOf(LearningValidationError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/learning/services/enrollment.test.ts`
Expected: FAIL with "Cannot find module './enrollment'".

- [ ] **Step 3: Write the implementation**

Create `src/modules/learning/services/enrollment.ts`:

```typescript
import type { CourseModuleKind, Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { getSetting } from "@/platform/settings/service";
import { gradeQuiz, type GradedQuestion } from "@/platform/quiz/grading";
import { coursesForMember, type AssignableCourse } from "../engine/assignment";
import { isCourseComplete, progressCounts, type ModuleState } from "../engine/completion";
import { LearningAuthError, LearningValidationError } from "./errors";
import { parseQuizQuestions, type QuizQuestion } from "./types";

type Tx = Prisma.TransactionClient;

/** Active term used for assignment (mirrors compliance/training: newest ACTIVE term). */
async function activeTermId(): Promise<string | null> {
  const term = await prisma.term.findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } });
  return term?.id ?? null;
}

/** Department ids the person is an active volunteer of in the active term. */
async function memberDepartmentIds(personId: string, termId: string): Promise<string[]> {
  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId, status: "ACTIVE" },
    select: { departmentId: true },
  });
  return memberships.map((m) => m.departmentId);
}

/** Resolve the active-course ids assigned to this person right now. */
async function assignedCourseIds(personId: string): Promise<string[]> {
  const termId = await activeTermId();
  if (!termId) return [];
  const memberDepts = await memberDepartmentIds(personId, termId);
  const courses = await prisma.course.findMany({
    where: { isActive: true },
    select: { id: true, isActive: true, assignToAll: true, departments: { select: { departmentId: true } } },
  });
  const assignable: AssignableCourse[] = courses.map((c) => ({
    id: c.id,
    isActive: c.isActive,
    assignToAll: c.assignToAll,
    departmentIds: c.departments.map((d) => d.departmentId),
  }));
  return coursesForMember({ courses: assignable, memberDepartmentIds: memberDepts });
}

export type MyCourseRow = {
  id: string;
  title: string;
  description: string | null;
  done: number;
  total: number;
  status: "IN_PROGRESS" | "COMPLETE";
};

export async function getMyCourses(personId: string): Promise<MyCourseRow[]> {
  const ids = await assignedCourseIds(personId);
  if (ids.length === 0) return [];
  const courses = await prisma.course.findMany({
    where: { id: { in: ids } },
    orderBy: { position: "asc" },
    include: { modules: { select: { id: true, kind: true } } },
  });
  const moduleIds = courses.flatMap((c) => c.modules.map((m) => m.id));
  const progress = await prisma.moduleProgress.findMany({
    where: { personId, moduleId: { in: moduleIds } },
    select: { moduleId: true, completedAt: true },
  });
  const passed = await latestPassByModule(personId, moduleIds);
  const completeByModule = new Map(progress.map((p) => [p.moduleId, p.completedAt != null]));

  return courses.map((c) => {
    const states = c.modules.map<ModuleState>((m) => ({
      kind: m.kind,
      completed: completeByModule.get(m.id) ?? false,
      quizPassed: passed.has(m.id),
    }));
    const counts = progressCounts(states);
    return {
      id: c.id,
      title: c.title,
      description: c.description,
      done: counts.done,
      total: counts.total,
      status: isCourseComplete(states) ? "COMPLETE" : "IN_PROGRESS",
    };
  });
}

/** Module ids the person has at least one passing attempt on. */
async function latestPassByModule(personId: string, moduleIds: string[]): Promise<Set<string>> {
  if (moduleIds.length === 0) return new Set();
  const rows = await prisma.moduleProgress.findMany({
    where: { personId, moduleId: { in: moduleIds }, attempts: { some: { passed: true } } },
    select: { moduleId: true },
  });
  return new Set(rows.map((r) => r.moduleId));
}

export type LearnerModule = {
  id: string;
  title: string;
  kind: CourseModuleKind;
  description: string | null;
  url: string | null;
  questions: QuizQuestion[];
  completed: boolean;
  quizPassed: boolean;
  locked: boolean;
  attemptsUsed: number;
  maxAttempts: number;
  passPercent: number;
};

export type LearnerCourse = {
  id: string;
  title: string;
  description: string | null;
  status: "IN_PROGRESS" | "COMPLETE";
  modules: LearnerModule[];
};

async function quizDefaults(): Promise<{ passPercent: number; maxAttempts: number }> {
  const [passPercent, maxAttempts] = await Promise.all([
    getSetting<number>("learning.defaultQuizPassPercent"),
    getSetting<number>("learning.defaultQuizMaxAttempts"),
  ]);
  return { passPercent, maxAttempts };
}

export async function getCourseForLearner(personId: string, courseId: string): Promise<LearnerCourse> {
  const ids = await assignedCourseIds(personId);
  if (!ids.includes(courseId)) {
    throw new LearningAuthError("This course is not assigned to you.");
  }
  const course = await prisma.course.findUniqueOrThrow({
    where: { id: courseId },
    include: { modules: { orderBy: { position: "asc" } } },
  });
  const defaults = await quizDefaults();
  const moduleIds = course.modules.map((m) => m.id);
  const progressRows = await prisma.moduleProgress.findMany({
    where: { personId, moduleId: { in: moduleIds } },
    include: { attempts: { orderBy: { takenAt: "desc" } } },
  });
  const progressByModule = new Map(progressRows.map((p) => [p.moduleId, p]));

  const modules = course.modules.map<LearnerModule>((m) => {
    const p = progressByModule.get(m.id);
    const windowStart = p?.lockResetAt ?? null;
    const attemptsUsed = (p?.attempts ?? []).filter((a) => !windowStart || a.takenAt >= windowStart).length;
    const quizPassed = (p?.attempts ?? []).some((a) => a.passed);
    return {
      id: m.id,
      title: m.title,
      kind: m.kind,
      description: m.description,
      url: m.url,
      questions: parseQuizQuestions(m.questions),
      completed: p?.completedAt != null,
      quizPassed,
      locked: p?.locked ?? false,
      attemptsUsed,
      maxAttempts: m.maxAttempts ?? defaults.maxAttempts,
      passPercent: m.passPercent ?? defaults.passPercent,
    };
  });

  const states = modules.map<ModuleState>((m) => ({ kind: m.kind, completed: m.completed, quizPassed: m.quizPassed }));
  return {
    id: course.id,
    title: course.title,
    description: course.description,
    status: isCourseComplete(states) ? "COMPLETE" : "IN_PROGRESS",
    modules,
  };
}

/** Recompute and persist CourseProgress for one person+course inside a tx. */
async function recomputeCourseProgress(tx: Tx, personId: string, courseId: string): Promise<void> {
  const modules = await tx.courseModule.findMany({ where: { courseId }, select: { id: true, kind: true } });
  const moduleIds = modules.map((m) => m.id);
  const progress = await tx.moduleProgress.findMany({
    where: { personId, moduleId: { in: moduleIds } },
    select: { moduleId: true, completedAt: true, attempts: { where: { passed: true }, select: { id: true }, take: 1 } },
  });
  const byModule = new Map(progress.map((p) => [p.moduleId, p]));
  const states = modules.map<ModuleState>((m) => {
    const p = byModule.get(m.id);
    return { kind: m.kind, completed: p?.completedAt != null, quizPassed: (p?.attempts.length ?? 0) > 0 };
  });
  const complete = isCourseComplete(states);
  await tx.courseProgress.upsert({
    where: { personId_courseId: { personId, courseId } },
    create: { personId, courseId, status: complete ? "COMPLETE" : "IN_PROGRESS", completedAt: complete ? new Date() : null },
    update: { status: complete ? "COMPLETE" : "IN_PROGRESS", completedAt: complete ? new Date() : null },
  });
}

export async function markModuleComplete(personId: string, moduleId: string): Promise<void> {
  const mod = await prisma.courseModule.findUniqueOrThrow({ where: { id: moduleId } });
  if (mod.kind === "QUIZ") {
    throw new LearningValidationError("Quiz modules are completed by passing the quiz.");
  }
  const ids = await assignedCourseIds(personId);
  if (!ids.includes(mod.courseId)) throw new LearningAuthError("This course is not assigned to you.");

  await prisma.$transaction(async (tx) => {
    await tx.moduleProgress.upsert({
      where: { personId_moduleId: { personId, moduleId } },
      create: { personId, moduleId, completedAt: new Date() },
      update: { completedAt: new Date() },
    });
    await recomputeCourseProgress(tx, personId, mod.courseId);
  });
}

export type CourseQuizResult = { score: number; total: number; percent: number; passed: boolean };

export async function submitCourseQuiz(
  personId: string,
  moduleId: string,
  answers: Record<string, unknown>
): Promise<CourseQuizResult> {
  const mod = await prisma.courseModule.findUniqueOrThrow({ where: { id: moduleId } });
  if (mod.kind !== "QUIZ") throw new LearningValidationError("This module is not a quiz.");
  const ids = await assignedCourseIds(personId);
  if (!ids.includes(mod.courseId)) throw new LearningAuthError("This course is not assigned to you.");

  const questions = parseQuizQuestions(mod.questions);
  if (questions.length === 0) throw new LearningValidationError("This quiz has no questions yet.");
  const graded: GradedQuestion[] = questions.map((q) => ({ key: q.key, correctValue: q.correctValue }));
  const defaults = await quizDefaults();
  const passPercent = mod.passPercent ?? defaults.passPercent;
  const maxAttempts = mod.maxAttempts ?? defaults.maxAttempts;

  return prisma.$transaction(async (tx) => {
    const mp = await tx.moduleProgress.upsert({
      where: { personId_moduleId: { personId, moduleId } },
      create: { personId, moduleId },
      update: {},
    });
    if (mp.locked) throw new LearningValidationError("This quiz is locked. Ask a manager to reset it.");

    const result = gradeQuiz(graded, answers, passPercent);
    await tx.courseQuizAttempt.create({
      data: { moduleProgressId: mp.id, answers: answers as object, score: result.score, total: result.total, passed: result.passed },
    });

    if (result.passed) {
      await tx.moduleProgress.update({ where: { id: mp.id }, data: { completedAt: new Date() } });
    } else {
      const windowAttempts = await tx.courseQuizAttempt.count({
        where: { moduleProgressId: mp.id, ...(mp.lockResetAt ? { takenAt: { gte: mp.lockResetAt } } : {}) },
      });
      if (windowAttempts >= maxAttempts) {
        await tx.moduleProgress.update({ where: { id: mp.id }, data: { locked: true } });
      }
    }
    await recomputeCourseProgress(tx, personId, mod.courseId);
    return { score: result.score, total: result.total, percent: result.percent, passed: result.passed };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/learning/services/enrollment.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/learning/services/enrollment.ts src/modules/learning/services/enrollment.test.ts
git commit -m "feat: add Learning enrollment and progress service"
```

---

## Task 9: Service — completion dashboard + quiz reset

**Files:**
- Create: `src/modules/learning/services/dashboard.ts`
- Create: `src/modules/learning/services/dashboard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/learning/services/dashboard.test.ts`:

```typescript
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { LearningAuthError } from "./errors";
import { getCourseCompletion, resetCourseQuiz } from "./dashboard";

async function seed() {
  const term = await prisma.term.create({ data: { code: "SU26", name: "Summer", startDate: new Date(), endDate: new Date(), status: "ACTIVE" } });
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const viewer = await prisma.person.create({ data: { name: "Viewer", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Learning Lead", grants: { create: [{ permission: "learning.view_progress" }, { permission: "learning.manage_courses" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: viewer.id, roleId: role.id } });
  const plain = await prisma.person.create({ data: { name: "Plain", status: "ACTIVE" } });

  const a = await prisma.person.create({ data: { name: "Alice", status: "ACTIVE" } });
  const b = await prisma.person.create({ data: { name: "Bob", status: "ACTIVE" } });
  for (const p of [a, b]) {
    await prisma.termMembership.create({ data: { personId: p.id, termId: term.id, departmentId: dept.id, kind: "VOLUNTEER", status: "ACTIVE" } });
  }
  const course = await prisma.course.create({ data: { title: "Intro", isActive: true } });
  await prisma.courseDepartment.create({ data: { courseId: course.id, departmentId: dept.id } });
  await prisma.courseProgress.create({ data: { personId: a.id, courseId: course.id, status: "COMPLETE", completedAt: new Date() } });
  const quiz = await prisma.courseModule.create({ data: { courseId: course.id, position: 0, title: "Quiz", kind: "QUIZ", questions: [] as object } });
  const mp = await prisma.moduleProgress.create({ data: { personId: b.id, moduleId: quiz.id, locked: true } });
  return { viewer, plain, course, a, b, quiz, mp };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("requires view_progress", async () => {
  const { plain, course } = await seed();
  await expect(getCourseCompletion(course.id, plain.id)).rejects.toBeInstanceOf(LearningAuthError);
});

it("reports complete vs outstanding learners for a course", async () => {
  const { viewer, course, a, b } = await seed();
  const rows = await getCourseCompletion(course.id, viewer.id);
  const alice = rows.find((r) => r.personId === a.id)!;
  const bob = rows.find((r) => r.personId === b.id)!;
  expect(alice.status).toBe("COMPLETE");
  expect(bob.status).toBe("NOT_STARTED");
});

it("resets a locked quiz and opens a fresh window", async () => {
  const { viewer, b, quiz } = await seed();
  await resetCourseQuiz(b.id, quiz.id, viewer.id);
  const mp = await prisma.moduleProgress.findUniqueOrThrow({ where: { personId_moduleId: { personId: b.id, moduleId: quiz.id } } });
  expect(mp.locked).toBe(false);
  expect(mp.lockResetAt).not.toBeNull();
});

it("blocks quiz reset without manage permission", async () => {
  const { plain, b, quiz } = await seed();
  await expect(resetCourseQuiz(b.id, quiz.id, plain.id)).rejects.toBeInstanceOf(LearningAuthError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/learning/services/dashboard.test.ts`
Expected: FAIL with "Cannot find module './dashboard'".

- [ ] **Step 3: Write the implementation**

Create `src/modules/learning/services/dashboard.ts`:

```typescript
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { LearningAuthError } from "./errors";

async function requireViewer(actorId: string): Promise<void> {
  if (!(await can(actorId, "learning.view_progress"))) {
    throw new LearningAuthError("You do not have permission to view training progress.");
  }
}

export type CompletionRow = {
  personId: string;
  name: string;
  departmentCode: string;
  status: "COMPLETE" | "IN_PROGRESS" | "NOT_STARTED";
  completedAt: Date | null;
  hasLockedQuiz: boolean;
};

/** For one course: every active member of an assigned department in the active
 *  term, with their completion status. assignToAll courses cover all departments. */
export async function getCourseCompletion(courseId: string, viewerId: string): Promise<CompletionRow[]> {
  await requireViewer(viewerId);
  const course = await prisma.course.findUniqueOrThrow({
    where: { id: courseId },
    include: { departments: { select: { departmentId: true } } },
  });
  const term = await prisma.term.findFirst({ where: { status: "ACTIVE" }, orderBy: { startDate: "desc" } });
  if (!term) return [];

  const deptFilter = course.assignToAll
    ? {}
    : { departmentId: { in: course.departments.map((d) => d.departmentId) } };

  const memberships = await prisma.termMembership.findMany({
    where: { termId: term.id, kind: "VOLUNTEER", status: "ACTIVE", ...deptFilter },
    include: { person: { select: { id: true, name: true } }, department: { select: { code: true } } },
  });

  const personIds = memberships.map((m) => m.person.id);
  const progress = new Map(
    (await prisma.courseProgress.findMany({ where: { courseId, personId: { in: personIds } } })).map((p) => [p.personId, p])
  );
  const lockedModulePersons = new Set(
    (
      await prisma.moduleProgress.findMany({
        where: { personId: { in: personIds }, locked: true, module: { courseId } },
        select: { personId: true },
      })
    ).map((m) => m.personId)
  );

  return memberships
    .map<CompletionRow>((m) => {
      const p = progress.get(m.person.id);
      const status = p ? p.status : "NOT_STARTED";
      return {
        personId: m.person.id,
        name: m.person.name,
        departmentCode: m.department.code,
        status,
        completedAt: p?.completedAt ?? null,
        hasLockedQuiz: lockedModulePersons.has(m.person.id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Clear a locked quiz module for a learner and open a fresh attempt window. */
export async function resetCourseQuiz(personId: string, moduleId: string, actorId: string): Promise<void> {
  if (!(await can(actorId, "learning.manage_courses"))) {
    throw new LearningAuthError("You do not have permission to reset quizzes.");
  }
  await prisma.moduleProgress.update({
    where: { personId_moduleId: { personId, moduleId } },
    data: { locked: false, lockResetAt: new Date() },
  });
  await recordAudit({ actorPersonId: actorId, action: "learning.quiz_reset", entityType: "CourseModule", entityId: moduleId, after: { personId } });
}

/** Active courses for the dashboard's course picker. */
export async function listCoursesForDashboard(viewerId: string): Promise<{ id: string; title: string }[]> {
  await requireViewer(viewerId);
  const courses = await prisma.course.findMany({ where: { isActive: true }, orderBy: { position: "asc" }, select: { id: true, title: true } });
  return courses;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/learning/services/dashboard.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/learning/services/dashboard.ts src/modules/learning/services/dashboard.test.ts
git commit -m "feat: add Learning completion dashboard service"
```

---

## Task 10: Register the module + permissions

**Files:**
- Modify: `src/platform/modules/registry.ts`

- [ ] **Step 1: Add the manifest**

In `src/platform/modules/registry.ts`, add `GraduationCap` to the existing `lucide-react` import (keep the list alphabetical), then add this entry to the `MODULES` array (place it after the `recruitment` entry):

```typescript
  {
    id: "learning",
    title: "Learning",
    description: "Self-paced training courses assigned by department",
    icon: GraduationCap,
    accessPermission: "learning.access",
    permissions: ["learning.access", "learning.manage_courses", "learning.view_progress"],
    status: "active",
    nav: [
      { label: "My courses", href: "/learning" },
      { label: "Manage courses", href: "/learning/manage" },
      { label: "Completion", href: "/learning/dashboard" },
    ],
  },
```

- [ ] **Step 2: Verify the registry/access tests still pass**

Run: `npx vitest run src/platform/modules`
Expected: PASS.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/platform/modules/registry.ts
git commit -m "feat: register Learning module"
```

---

## Task 11: Learner routes — course list and detail

These are Server Components plus a thin Server Actions file. UI follows the `AppShell` + `PageHeader` pattern from `src/app/training/page.tsx`. There is no automated test here (e2e deferred per spec); verification is manual in Task 13.

**Files:**
- Create: `src/app/learning/actions.ts`
- Create: `src/app/learning/page.tsx`
- Create: `src/app/learning/[courseId]/page.tsx`

- [ ] **Step 1: Write the learner actions**

Create `src/app/learning/actions.ts`:

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { requirePersonSession } from "@/platform/auth/session";
import { markModuleComplete, submitCourseQuiz } from "@/modules/learning/services/enrollment";

export async function markModuleCompleteAction(formData: FormData): Promise<void> {
  const person = await requirePersonSession();
  const moduleId = String(formData.get("moduleId"));
  const courseId = String(formData.get("courseId"));
  await markModuleComplete(person.personId, moduleId);
  revalidatePath(`/learning/${courseId}`);
}

export async function submitCourseQuizAction(formData: FormData): Promise<void> {
  const person = await requirePersonSession();
  const moduleId = String(formData.get("moduleId"));
  const courseId = String(formData.get("courseId"));
  const answers: Record<string, string> = {};
  for (const [name, value] of formData.entries()) {
    if (name.startsWith("q:")) answers[name.slice(2)] = String(value);
  }
  await submitCourseQuiz(person.personId, moduleId, answers);
  revalidatePath(`/learning/${courseId}`);
}
```

- [ ] **Step 2: Write the course-list page**

Create `src/app/learning/page.tsx`:

```tsx
import Link from "next/link";
import { requireModuleAccess } from "@/platform/auth/session";
import { AppShell } from "@/platform/ui/app-shell";
import { PageHeader } from "@/platform/ui/page-header";
import { getMyCourses } from "@/modules/learning/services/enrollment";

export default async function LearningPage() {
  const person = await requireModuleAccess("learning");
  const courses = await getMyCourses(person.personId);

  return (
    <AppShell userName={person.name} personId={person.personId}>
      <PageHeader title="Learning" description="Complete the training courses assigned to your department." />
      <div className="mt-6 max-w-2xl space-y-3">
        {courses.length === 0 && (
          <p className="text-sm text-slate-500">You have no assigned courses right now.</p>
        )}
        {courses.map((c) => (
          <Link
            key={c.id}
            href={`/learning/${c.id}`}
            className="block rounded border border-slate-200 px-4 py-3 hover:border-slate-400"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{c.title}</span>
              <span
                className={
                  c.status === "COMPLETE"
                    ? "rounded bg-green-50 px-2 py-0.5 text-xs text-green-800"
                    : "rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                }
              >
                {c.status === "COMPLETE" ? "Complete" : `${c.done}/${c.total} done`}
              </span>
            </div>
            {c.description && <p className="mt-1 text-sm text-slate-500">{c.description}</p>}
          </Link>
        ))}
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 3: Write the course-detail page**

Create `src/app/learning/[courseId]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { AppShell } from "@/platform/ui/app-shell";
import { PageHeader } from "@/platform/ui/page-header";
import { getCourseForLearner } from "@/modules/learning/services/enrollment";
import { LearningAuthError } from "@/modules/learning/services/errors";
import { markModuleCompleteAction, submitCourseQuizAction } from "../actions";

export default async function LearningCoursePage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const person = await requireModuleAccess("learning");
  const { courseId } = await params;

  let course;
  try {
    course = await getCourseForLearner(person.personId, courseId);
  } catch (err) {
    if (err instanceof LearningAuthError) notFound();
    throw err;
  }

  return (
    <AppShell userName={person.name} personId={person.personId}>
      <PageHeader title={course.title} description={course.description ?? undefined} />
      <div className="mt-6 max-w-2xl space-y-5">
        {course.status === "COMPLETE" && (
          <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">
            You have completed this course.
          </p>
        )}
        {course.modules.map((m, i) => (
          <section key={m.id} className="rounded border border-slate-200 p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">
                {i + 1}. {m.title}
              </h2>
              {(m.kind === "VIDEO" || m.kind === "DOCUMENT") && m.completed && (
                <span className="text-xs text-green-700">Done</span>
              )}
              {m.kind === "QUIZ" && m.quizPassed && <span className="text-xs text-green-700">Passed</span>}
            </div>
            {m.description && <p className="mt-1 text-sm text-slate-500">{m.description}</p>}

            {(m.kind === "VIDEO" || m.kind === "DOCUMENT") && (
              <div className="mt-3 flex items-center gap-3 text-sm">
                {m.url && (
                  <a className="text-blue-700 underline" href={m.url} target="_blank" rel="noreferrer">
                    Open {m.kind === "VIDEO" ? "video" : "document"}
                  </a>
                )}
                {!m.completed && (
                  <form action={markModuleCompleteAction}>
                    <input type="hidden" name="moduleId" value={m.id} />
                    <input type="hidden" name="courseId" value={course.id} />
                    <button className="rounded bg-slate-800 px-3 py-1 text-white" type="submit">
                      Mark complete
                    </button>
                  </form>
                )}
              </div>
            )}

            {m.kind === "QUIZ" && !m.quizPassed && (
              <div className="mt-3 text-sm">
                {m.locked ? (
                  <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-red-700">
                    This quiz is locked after {m.maxAttempts} attempts. Ask a manager to reset it.
                  </p>
                ) : (
                  <form action={submitCourseQuizAction} className="space-y-4">
                    <input type="hidden" name="moduleId" value={m.id} />
                    <input type="hidden" name="courseId" value={course.id} />
                    <p className="text-slate-500">
                      Need {m.passPercent}% to pass. {m.maxAttempts - m.attemptsUsed} attempt(s) left.
                    </p>
                    {m.questions.map((q) => (
                      <fieldset key={q.key} className="space-y-1">
                        <legend className="font-medium">{q.label}</legend>
                        {q.options.map((opt) => (
                          <label key={opt.value} className="flex items-center gap-2">
                            <input type="radio" name={`q:${q.key}`} value={opt.value} required />
                            {opt.label}
                          </label>
                        ))}
                      </fieldset>
                    ))}
                    <button className="rounded bg-slate-800 px-3 py-1 text-white" type="submit">
                      Submit quiz
                    </button>
                  </form>
                )}
              </div>
            )}
          </section>
        ))}
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit && npx next lint --dir src/app/learning`
Expected: no errors. (If `AppShell`/`PageHeader` props differ from `src/app/training/page.tsx`, match that file's exact prop usage.)

- [ ] **Step 5: Commit**

```bash
git add src/app/learning/actions.ts src/app/learning/page.tsx "src/app/learning/[courseId]/page.tsx"
git commit -m "feat: add Learning learner routes"
```

---

## Task 12: Management + dashboard routes

Management uses simple form-based authoring (no drag-drop in v1; reordering via up/down is deferred — modules are created in order). Quiz authoring accepts pasted JSON questions to keep v1 small; a richer builder is a follow-up.

**Files:**
- Create: `src/app/learning/manage/actions.ts`
- Create: `src/app/learning/manage/page.tsx`
- Create: `src/app/learning/manage/[courseId]/page.tsx`
- Create: `src/app/learning/dashboard/actions.ts`
- Create: `src/app/learning/dashboard/page.tsx`

- [ ] **Step 1: Management actions**

Create `src/app/learning/manage/actions.ts`:

```typescript
"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { createCourse, updateCourse, setCourseAssignment, addModule } from "@/modules/learning/services/courses";
import { LearningValidationError } from "@/modules/learning/services/errors";
import type { QuizQuestion } from "@/modules/learning/services/types";
import type { CourseModuleKind } from "@prisma/client";

export async function createCourseAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const course = await createCourse(
    { title: String(formData.get("title") ?? ""), description: String(formData.get("description") ?? "") },
    person.personId
  );
  redirect(`/learning/manage/${course.id}`);
}

export async function updateCourseAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const id = String(formData.get("courseId"));
  await updateCourse(
    id,
    {
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? ""),
      isActive: formData.get("isActive") === "on",
    },
    person.personId
  );
  revalidatePath(`/learning/manage/${id}`);
}

export async function setAssignmentAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  const departmentIds = formData.getAll("departmentIds").map(String);
  await setCourseAssignment(courseId, { departmentIds, assignToAll: formData.get("assignToAll") === "on" }, person.personId);
  revalidatePath(`/learning/manage/${courseId}`);
}

export async function addModuleAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  const kind = String(formData.get("kind")) as CourseModuleKind;
  let questions: QuizQuestion[] | undefined;
  if (kind === "QUIZ") {
    try {
      questions = JSON.parse(String(formData.get("questions") ?? "[]")) as QuizQuestion[];
    } catch {
      throw new LearningValidationError("Questions must be valid JSON.");
    }
  }
  await addModule(
    courseId,
    {
      title: String(formData.get("title") ?? ""),
      kind,
      description: String(formData.get("description") ?? ""),
      url: String(formData.get("url") ?? ""),
      questions,
      passPercent: formData.get("passPercent") ? Number(formData.get("passPercent")) : null,
      maxAttempts: formData.get("maxAttempts") ? Number(formData.get("maxAttempts")) : null,
    },
    person.personId
  );
  revalidatePath(`/learning/manage/${courseId}`);
}
```

- [ ] **Step 2: Management list page**

Create `src/app/learning/manage/page.tsx`:

```tsx
import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { AppShell } from "@/platform/ui/app-shell";
import { PageHeader } from "@/platform/ui/page-header";
import { listCourses } from "@/modules/learning/services/courses";
import { createCourseAction } from "./actions";

export default async function ManageCoursesPage() {
  const person = await requirePermission("learning.manage_courses");
  const courses = await listCourses();

  return (
    <AppShell userName={person.name} personId={person.personId}>
      <PageHeader title="Manage courses" description="Create and edit training courses." />
      <div className="mt-6 max-w-2xl space-y-6">
        <form action={createCourseAction} className="flex gap-2">
          <input name="title" placeholder="New course title" required className="flex-1 rounded border border-slate-300 px-3 py-1.5" />
          <button className="rounded bg-slate-800 px-3 py-1.5 text-white" type="submit">Create</button>
        </form>
        <ul className="space-y-2">
          {courses.map((c) => (
            <li key={c.id}>
              <Link href={`/learning/manage/${c.id}`} className="flex items-center justify-between rounded border border-slate-200 px-4 py-2 hover:border-slate-400">
                <span>{c.title}</span>
                <span className="text-xs text-slate-500">
                  {c.moduleCount} module(s){c.isActive ? "" : " · inactive"}{c.assignToAll ? " · all depts" : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 3: Single-course editor page**

Create `src/app/learning/manage/[courseId]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { AppShell } from "@/platform/ui/app-shell";
import { PageHeader } from "@/platform/ui/page-header";
import { getCourseForEdit } from "@/modules/learning/services/courses";
import { updateCourseAction, setAssignmentAction, addModuleAction } from "../actions";

export default async function EditCoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  const person = await requirePermission("learning.manage_courses");
  const { courseId } = await params;
  const course = await getCourseForEdit(courseId);
  if (!course) notFound();
  const departments = await prisma.department.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
  const assignedDeptIds = new Set(course.departments.map((d) => d.departmentId));

  return (
    <AppShell userName={person.name} personId={person.personId}>
      <PageHeader title={`Edit: ${course.title}`} />
      <div className="mt-6 grid max-w-3xl gap-8">
        <form action={updateCourseAction} className="space-y-2">
          <input type="hidden" name="courseId" value={course.id} />
          <input name="title" defaultValue={course.title} className="w-full rounded border border-slate-300 px-3 py-1.5" />
          <textarea name="description" defaultValue={course.description ?? ""} placeholder="Description" className="w-full rounded border border-slate-300 px-3 py-1.5" />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isActive" defaultChecked={course.isActive} /> Active</label>
          <button className="rounded bg-slate-800 px-3 py-1.5 text-white" type="submit">Save course</button>
        </form>

        <form action={setAssignmentAction} className="space-y-2">
          <input type="hidden" name="courseId" value={course.id} />
          <h2 className="font-medium">Assignment</h2>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="assignToAll" defaultChecked={course.assignToAll} /> Assign to all departments</label>
          <div className="grid grid-cols-2 gap-1 text-sm">
            {departments.map((d) => (
              <label key={d.id} className="flex items-center gap-2">
                <input type="checkbox" name="departmentIds" value={d.id} defaultChecked={assignedDeptIds.has(d.id)} /> {d.name}
              </label>
            ))}
          </div>
          <button className="rounded bg-slate-800 px-3 py-1.5 text-white" type="submit">Save assignment</button>
        </form>

        <div className="space-y-2">
          <h2 className="font-medium">Modules</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {course.modules.map((m) => (
              <li key={m.id}>{m.title} <span className="text-slate-400">({m.kind})</span></li>
            ))}
          </ol>
          <form action={addModuleAction} className="space-y-2 rounded border border-slate-200 p-3">
            <input type="hidden" name="courseId" value={course.id} />
            <input name="title" placeholder="Module title" required className="w-full rounded border border-slate-300 px-3 py-1.5" />
            <select name="kind" className="w-full rounded border border-slate-300 px-3 py-1.5">
              <option value="VIDEO">Video</option>
              <option value="DOCUMENT">Document</option>
              <option value="QUIZ">Quiz</option>
            </select>
            <input name="url" placeholder="Link (video/document)" className="w-full rounded border border-slate-300 px-3 py-1.5" />
            <textarea name="questions" placeholder='Quiz questions JSON: [{"key":"q1","label":"...","options":[{"value":"a","label":"A"}],"correctValue":"a"}]' className="w-full rounded border border-slate-300 px-3 py-1.5 font-mono text-xs" />
            <div className="flex gap-2">
              <input name="passPercent" type="number" placeholder="Pass %" className="w-24 rounded border border-slate-300 px-3 py-1.5" />
              <input name="maxAttempts" type="number" placeholder="Attempts" className="w-24 rounded border border-slate-300 px-3 py-1.5" />
            </div>
            <button className="rounded bg-slate-800 px-3 py-1.5 text-white" type="submit">Add module</button>
          </form>
        </div>
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 4: Dashboard action + page**

Create `src/app/learning/dashboard/actions.ts`:

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { resetCourseQuiz } from "@/modules/learning/services/dashboard";

export async function resetCourseQuizAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  await resetCourseQuiz(String(formData.get("personId")), String(formData.get("moduleId")), person.personId);
  revalidatePath("/learning/dashboard");
}
```

Create `src/app/learning/dashboard/page.tsx`:

```tsx
import { requirePermission } from "@/platform/auth/session";
import { AppShell } from "@/platform/ui/app-shell";
import { PageHeader } from "@/platform/ui/page-header";
import { listCoursesForDashboard, getCourseCompletion } from "@/modules/learning/services/dashboard";

export default async function LearningDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ course?: string }>;
}) {
  const person = await requirePermission("learning.view_progress");
  const courses = await listCoursesForDashboard(person.personId);
  const sp = await searchParams;
  const selected = sp.course ?? courses[0]?.id;
  const rows = selected ? await getCourseCompletion(selected, person.personId) : [];

  return (
    <AppShell userName={person.name} personId={person.personId}>
      <PageHeader title="Course completion" description="Who has completed each course, by department." />
      <div className="mt-6 max-w-3xl space-y-4">
        <form method="get" className="flex items-center gap-2 text-sm">
          <label htmlFor="course">Course</label>
          <select id="course" name="course" defaultValue={selected} className="rounded border border-slate-300 px-3 py-1.5">
            {courses.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
          <button className="rounded bg-slate-800 px-3 py-1 text-white" type="submit">View</button>
        </form>

        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-slate-500">
            <tr><th className="py-2">Name</th><th>Dept</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.personId} className="border-b border-slate-100">
                <td className="py-2">{r.name}</td>
                <td>{r.departmentCode}</td>
                <td>
                  {r.status === "COMPLETE" ? "Complete" : r.status === "IN_PROGRESS" ? "In progress" : "Not started"}
                  {r.hasLockedQuiz && <span className="ml-2 text-xs text-red-600">locked</span>}
                </td>
                <td className="text-right text-xs text-slate-400">{r.completedAt ? r.completedAt.toLocaleDateString() : ""}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={4} className="py-3 text-slate-500">No learners for this course.</td></tr>}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx next lint --dir src/app/learning`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/learning/manage src/app/learning/dashboard
git commit -m "feat: add Learning management and dashboard routes"
```

---

## Task 13: Full-suite verification and manual smoke test

**Files:** none (verification only).

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: PASS (including the moved grader test and all new learning tests).

- [ ] **Step 2: Typecheck and lint the project**

Run: `npx tsc --noEmit && npx next lint`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `npx next build`
Expected: build succeeds; `/learning`, `/learning/[courseId]`, `/learning/manage`, `/learning/manage/[courseId]`, `/learning/dashboard` all appear in the route list.

- [ ] **Step 4: Manual smoke test (dev)**

Run: `docker compose up -d postgres && npm run dev` (or the project's documented dev command). Then, signed in as a user holding `learning.manage_courses` + `learning.view_progress`:
1. `/learning/manage` → create a course → add a VIDEO module (url), a DOCUMENT module (url), and a QUIZ module (paste valid questions JSON, pass 100, attempts 2) → assign it to a department you are an active member of this term.
2. `/learning` → the course appears with `0/3 done`.
3. Open the course → Open each link, Mark complete the two link modules, take the quiz and pass → course shows Complete.
4. `/learning/dashboard` → select the course → your row shows Complete.
5. Fail a quiz on a second test learner until it locks → reset it from the dashboard action wiring (or confirm `learning.quiz_reset` appears in `/admin/audit`).

- [ ] **Step 5: Commit any fixes found during smoke test, then finish**

```bash
git add -A
git commit -m "fix: address Learning smoke-test findings"
```

If no fixes were needed, skip the commit.

---

## Notes for the implementer

- **Permission grants:** `learning.access` must be granted to the role(s) volunteers hold, and `learning.manage_courses` / `learning.view_progress` to training leads, via the existing roles admin (`/admin/roles`). The module declares the permission strings; granting them to people is an operational step, not code.
- **`AppShell` / `PageHeader` props:** mirror `src/app/training/page.tsx` exactly. That file passes `userName`, `personId`, and (when relevant) `termLabel`. If your pages don't have a term, omit `termLabel`.
- **Quiz authoring via JSON** is a deliberate v1 simplification (spec: hybrid authoring, content external). A structured quiz builder and module reorder/delete UI are noted follow-ups; the underlying services (`reorderModules`, `deleteModule`, `updateModule`) already exist for when that UI is built.
