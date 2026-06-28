# Learning Course Audience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins target a learning course at directors, volunteers, or everyone, composed with the existing department / assign-to-all scoping.

**Architecture:** Add a `Course.audience` enum (`EVERYONE | DIRECTORS | VOLUNTEERS`, default `EVERYONE`). Thread membership kind through the pure assignment engine so a course is assigned iff some active membership satisfies both the department scope and the audience. Apply the same audience filter in the completion dashboard, and expose an audience selector in the manage UI.

**Tech Stack:** Next.js (App Router, server components/actions), Prisma + Postgres, Vitest (integration tests against a Postgres test DB), TypeScript.

## Global Constraints

- No em-dashes anywhere (prose, UI copy, code comments). Use commas, parentheses, or periods.
- "HAVEN Hub" is two words in prose/UI; identifiers stay `havenhub`.
- `CourseAudience` enum values: `EVERYONE`, `DIRECTORS`, `VOLUNTEERS`. Default `EVERYONE`.
- `MembershipKind` enum values (existing): `DIRECTOR`, `VOLUNTEER`.
- UI audience labels: "Everyone", "Directors only", "Volunteers only".
- Matching rule (verbatim): a course is assigned to a person iff there exists an active `TermMembership` `m` in the active term with `(course.assignToAll OR m.departmentId ∈ course.departments) AND (course.audience == EVERYONE OR m.kind == audienceToKind(course.audience))`.

## Prerequisites (run once before Task 1)

Per-worktree Postgres test DB (the suite needs `TEST_DATABASE_URL`; Postgres runs in docker on port 5434):

```bash
cd /Users/jcarney/Documents/Code-Projects/HAVENHub/.claude/worktrees/feat+learning-course-audience
PGPASSWORD=haven_dev psql -h localhost -p 5434 -U haven -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='havenhub_test_lca'" | grep -q 1 \
  || PGPASSWORD=haven_dev psql -h localhost -p 5434 -U haven -d postgres -c "CREATE DATABASE havenhub_test_lca"
export TEST_DATABASE_URL="postgresql://haven:haven_dev@localhost:5434/havenhub_test_lca"
DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL_UNPOOLED="$TEST_DATABASE_URL" npx prisma migrate deploy
```

Export `TEST_DATABASE_URL` in every shell that runs `npm test` / `npx vitest`.

---

### Task 1: Schema, add `Course.audience` + migration + regenerate client

**Files:**
- Modify: `prisma/schema.prisma` (Course model + new enum)
- Create: `prisma/migrations/20260628120000_course_audience/migration.sql`

**Interfaces:**
- Produces: Prisma types `CourseAudience` (`'EVERYONE' | 'DIRECTORS' | 'VOLUNTEERS'`) and the existing `MembershipKind`, plus `Course.audience` field. Tasks 2-5 import `CourseAudience` from `@prisma/client`.

- [ ] **Step 1: Add the enum and field to the schema**

In `prisma/schema.prisma`, add the field to `model Course` (after the `assignToAll` line):

```prisma
  /// Who the course targets, composed with department / assignToAll scoping.
  audience        CourseAudience     @default(EVERYONE)
```

And add the enum next to the other enums (e.g. directly after the `Course` model or near `MembershipKind`):

```prisma
enum CourseAudience {
  EVERYONE
  DIRECTORS
  VOLUNTEERS
}
```

- [ ] **Step 2: Regenerate the Prisma client (no DB needed)**

Run: `npx prisma generate`
Expected: "Generated Prisma Client" with no errors. `CourseAudience` is now a TS type.

- [ ] **Step 3: Hand-author the migration**

Create `prisma/migrations/20260628120000_course_audience/migration.sql` (bump the timestamp prefix if any later migration already exists so it sorts last):

```sql
-- Add a per-course audience so a course can target directors, volunteers, or
-- everyone, composed with the existing department / assignToAll scoping.
-- Default EVERYONE preserves current behavior for all existing courses.
CREATE TYPE "CourseAudience" AS ENUM ('EVERYONE', 'DIRECTORS', 'VOLUNTEERS');
ALTER TABLE "Course" ADD COLUMN "audience" "CourseAudience" NOT NULL DEFAULT 'EVERYONE';
```

- [ ] **Step 4: Apply the migration to the test DB**

Run:
```bash
DATABASE_URL="$TEST_DATABASE_URL" DATABASE_URL_UNPOOLED="$TEST_DATABASE_URL" npx prisma migrate deploy
```
Expected: "All migrations have been successfully applied." (or "No pending migrations" if already applied).

- [ ] **Step 5: Verify the column and default**

Run:
```bash
PGPASSWORD=haven_dev psql -h localhost -p 5434 -U haven -d havenhub_test_lca -tAc \
  "SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name='Course' AND column_name='audience';"
```
Expected: `audience|USER-DEFINED|'EVERYONE'::"CourseAudience"`

Then typecheck: `npx tsc --noEmit`
Expected: no errors (existing code still compiles; `audience` has a DB default so inserts that omit it are fine).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260628120000_course_audience/
git commit -m "feat(learning): add Course.audience enum (EVERYONE/DIRECTORS/VOLUNTEERS)"
```

---

### Task 2: Engine + enrollment resolver, thread kind and audience

`coursesForMember` is called only by the enrollment resolver, so the signature change and its caller move together to keep the tree compiling.

**Files:**
- Modify: `src/modules/learning/engine/assignment.ts`
- Modify: `src/modules/learning/engine/assignment.test.ts`
- Modify: `src/modules/learning/services/enrollment.ts:14-40`
- Modify: `src/modules/learning/services/enrollment.test.ts`

**Interfaces:**
- Produces:
  - `type MemberMembership = { departmentId: string; kind: MembershipKind }`
  - `AssignableCourse` gains `audience: CourseAudience`
  - `coursesForMember(params: { courses: AssignableCourse[]; memberships: MemberMembership[] }): string[]`
  - `audienceToKind(audience: CourseAudience): MembershipKind | null` (used by Task 4)
  - `kindMatchesAudience(kind: MembershipKind, audience: CourseAudience): boolean`

- [ ] **Step 1: Rewrite the engine unit tests (failing)**

Replace the entire contents of `src/modules/learning/engine/assignment.test.ts` with:

```typescript
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
```

- [ ] **Step 2: Run the engine tests to verify they fail**

Run: `npx vitest run src/modules/learning/engine/assignment.test.ts`
Expected: FAIL. Type/compile error (`memberships` not a known param, `kindMatchesAudience` not exported, `audience` not on `AssignableCourse`).

- [ ] **Step 3: Implement the engine**

Replace the entire contents of `src/modules/learning/engine/assignment.ts` with:

```typescript
/** Pure assignment resolution. No DB. A member is assigned a course when it is
 *  active, has an uploaded SCORM package, falls in scope (org-wide assignToAll or
 *  a department the member belongs to), and the member's matching membership kind
 *  satisfies the course audience. A course that is inactive, package-less, or has
 *  no scope (no departments and not assignToAll) is a draft assigned to no one.
 *  Excluding package-less courses keeps an admin who assigns a course before
 *  uploading its package from locking every assigned member out of the onboarding
 *  gate with a requirement they can never complete (the player has no SCO to
 *  finish). */
import type { CourseAudience, MembershipKind } from "@prisma/client";

export type AssignableCourse = {
  id: string;
  isActive: boolean;
  assignToAll: boolean;
  departmentIds: string[];
  /** True once a SCORM package has been ingested (Course.scormEntryHref set). */
  hasPackage: boolean;
  /** Who the course targets: EVERYONE, DIRECTORS, or VOLUNTEERS. */
  audience: CourseAudience;
};

/** One of the member's active memberships: the department and the kind held in it. */
export type MemberMembership = { departmentId: string; kind: MembershipKind };

/** The membership kind a non-EVERYONE audience requires, or null for EVERYONE. */
export function audienceToKind(audience: CourseAudience): MembershipKind | null {
  switch (audience) {
    case "DIRECTORS":
      return "DIRECTOR";
    case "VOLUNTEERS":
      return "VOLUNTEER";
    default:
      return null; // EVERYONE
  }
}

/** True when a membership of this kind satisfies the course audience. */
export function kindMatchesAudience(kind: MembershipKind, audience: CourseAudience): boolean {
  const required = audienceToKind(audience);
  return required === null || kind === required;
}

export function coursesForMember(params: {
  courses: AssignableCourse[];
  memberships: MemberMembership[];
}): string[] {
  const out: string[] = [];
  for (const course of params.courses) {
    if (!course.isActive) continue;
    if (!course.hasPackage) continue;
    const assigned = params.memberships.some(
      (m) =>
        (course.assignToAll || course.departmentIds.includes(m.departmentId)) &&
        kindMatchesAudience(m.kind, course.audience)
    );
    if (assigned) out.push(course.id);
  }
  return out;
}
```

- [ ] **Step 4: Run the engine tests to verify they pass**

Run: `npx vitest run src/modules/learning/engine/assignment.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Update the enrollment resolver**

In `src/modules/learning/services/enrollment.ts`:

Change the import on line 3 to add `MemberMembership`:

```typescript
import { coursesForMember, type AssignableCourse, type MemberMembership } from "../engine/assignment";
```

Replace `memberDepartmentIds` (lines 14-21) with:

```typescript
/** The member's active memberships in the active term: department + kind. */
async function memberMemberships(personId: string, termId: string): Promise<MemberMembership[]> {
  const memberships = await prisma.termMembership.findMany({
    where: { personId, termId, status: "ACTIVE" },
    select: { departmentId: true, kind: true },
  });
  return memberships.map((m) => ({ departmentId: m.departmentId, kind: m.kind }));
}
```

Replace `assignedCourseIds` (lines 23-40) with:

```typescript
/** Resolve the active-course ids assigned to this person right now. */
async function assignedCourseIds(personId: string): Promise<string[]> {
  const termId = await activeTermId();
  if (!termId) return [];
  const memberships = await memberMemberships(personId, termId);
  const courses = await prisma.course.findMany({
    where: { isActive: true },
    select: { id: true, isActive: true, assignToAll: true, audience: true, scormEntryHref: true, departments: { select: { departmentId: true } } },
  });
  const assignable: AssignableCourse[] = courses.map((c) => ({
    id: c.id,
    isActive: c.isActive,
    assignToAll: c.assignToAll,
    departmentIds: c.departments.map((d) => d.departmentId),
    hasPackage: c.scormEntryHref != null,
    audience: c.audience,
  }));
  return coursesForMember({ courses: assignable, memberships });
}
```

- [ ] **Step 6: Add enrollment integration tests (failing first, then pass)**

Append to `src/modules/learning/services/enrollment.test.ts` (the existing `seed()` returns `{ learner, dept, course, unassigned }`; `learner` is a VOLUNTEER in `dept`, `course` is an EVERYONE course on `dept`):

```typescript
it("excludes a DIRECTORS course from a volunteer's assigned courses", async () => {
  const { learner, dept } = await seed();
  const dirCourse = await prisma.course.create({
    data: { title: "Dir only", scormEntryHref: "index.html", audience: "DIRECTORS", departments: { create: [{ departmentId: dept.id }] } },
  });
  const ids = (await getMyCourses(learner.id)).map((r) => r.id);
  expect(ids).not.toContain(dirCourse.id);
});

it("includes a DIRECTORS course for a director in the department, alongside EVERYONE courses", async () => {
  const { dept, course } = await seed();
  const term = await prisma.term.findFirstOrThrow();
  const director = await prisma.person.create({ data: { name: "Dee", status: "ACTIVE" } });
  await prisma.termMembership.create({
    data: { personId: director.id, termId: term.id, departmentId: dept.id, status: "ACTIVE", kind: "DIRECTOR" },
  });
  const dirCourse = await prisma.course.create({
    data: { title: "Dir only", scormEntryHref: "index.html", audience: "DIRECTORS", departments: { create: [{ departmentId: dept.id }] } },
  });
  const ids = (await getMyCourses(director.id)).map((r) => r.id);
  expect(ids).toContain(dirCourse.id);
  expect(ids).toContain(course.id);
});
```

Run (verify fail BEFORE Step 5 is done; if Step 5 already applied, this confirms pass): `npx vitest run src/modules/learning/services/enrollment.test.ts`
Expected after Step 5: PASS (existing + 2 new tests).

- [ ] **Step 7: Run both test files + typecheck**

Run:
```bash
npx vitest run src/modules/learning/engine/assignment.test.ts src/modules/learning/services/enrollment.test.ts
npx tsc --noEmit
```
Expected: all tests PASS; tsc no errors.

- [ ] **Step 8: Commit**

```bash
git add src/modules/learning/engine/assignment.ts src/modules/learning/engine/assignment.test.ts src/modules/learning/services/enrollment.ts src/modules/learning/services/enrollment.test.ts
git commit -m "feat(learning): assign courses by membership kind via course audience"
```

---

### Task 3: Completion dashboard, apply the audience filter

**Files:**
- Modify: `src/modules/learning/services/dashboard.ts:23-41`
- Modify: `src/modules/learning/services/dashboard.test.ts`

**Interfaces:**
- Consumes: `audienceToKind` from `../engine/assignment` (Task 2).

- [ ] **Step 1: Add a failing dashboard test**

Append to `src/modules/learning/services/dashboard.test.ts` (existing `seed()` returns `{ viewer, learner, dept, course }`; `learner` is a VOLUNTEER in `dept`):

```typescript
it("a DIRECTORS course lists directors of the assigned department and excludes volunteers", async () => {
  const { viewer, learner, dept } = await seed();
  const term = await prisma.term.findFirstOrThrow();
  const director = await prisma.person.create({ data: { name: "Dee", status: "ACTIVE" } });
  await prisma.termMembership.create({
    data: { personId: director.id, termId: term.id, departmentId: dept.id, status: "ACTIVE", kind: "DIRECTOR" },
  });
  const dirCourse = await prisma.course.create({
    data: { title: "Dir only", scormEntryHref: "index.html", audience: "DIRECTORS", departments: { create: [{ departmentId: dept.id }] } },
  });
  const ids = (await getCourseCompletion(dirCourse.id, viewer.id)).map((r) => r.personId);
  expect(ids).toContain(director.id);
  expect(ids).not.toContain(learner.id);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/learning/services/dashboard.test.ts`
Expected: FAIL. The volunteer `learner` is still listed (no kind filter yet), so `ids` contains `learner.id`.

- [ ] **Step 3: Implement the filter**

In `src/modules/learning/services/dashboard.ts`:

Add to the imports at the top of the file:

```typescript
import { audienceToKind } from "../engine/assignment";
```

Replace the membership query block (currently lines 34-41) with:

```typescript
  const deptFilter = course.assignToAll
    ? {}
    : { departmentId: { in: course.departments.map((d) => d.departmentId) } };
  const kind = audienceToKind(course.audience);

  const memberships = await prisma.termMembership.findMany({
    where: { termId: term.id, status: "ACTIVE", ...deptFilter, ...(kind ? { kind } : {}) },
    include: { person: { select: { id: true, name: true } }, department: { select: { code: true } } },
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/learning/services/dashboard.test.ts`
Expected: PASS (existing + new test). Also run `npx tsc --noEmit`. No errors.

- [ ] **Step 5: Commit**

```bash
git add src/modules/learning/services/dashboard.ts src/modules/learning/services/dashboard.test.ts
git commit -m "feat(learning): filter completion dashboard by course audience"
```

---

### Task 4: Assignment service + action + manage UI

**Files:**
- Modify: `src/modules/learning/services/courses.ts:1` (import) and `:67-90` (`setCourseAssignment`)
- Modify: `src/modules/learning/services/courses.test.ts:59-65` (existing call) + new test
- Modify: `src/app/(app)/learning/manage/actions.ts:39-45` (`setAssignmentAction`)
- Modify: `src/app/(app)/learning/manage/[courseId]/page.tsx:42-54` (assignment form)

**Interfaces:**
- Consumes: `CourseAudience` from `@prisma/client`.
- Produces: `setCourseAssignment(courseId, { departmentIds, assignToAll, audience }, actorId)`.

- [ ] **Step 1: Update existing test call + add a failing audience test**

In `src/modules/learning/services/courses.test.ts`, update the existing "sets department assignment" test call (line 62) to include `audience`:

```typescript
  await setCourseAssignment(course.id, { departmentIds: [dept.id], assignToAll: false, audience: "EVERYONE" }, manager.id);
```

Then append a new test:

```typescript
it("persists the course audience", async () => {
  const { manager, dept } = await seed();
  const course = await createCourse({ title: "Intro" }, manager.id);
  await setCourseAssignment(course.id, { departmentIds: [dept.id], assignToAll: false, audience: "DIRECTORS" }, manager.id);
  const edited = await getCourseForEdit(course.id);
  expect(edited!.audience).toBe("DIRECTORS");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/learning/services/courses.test.ts`
Expected: FAIL. `audience` is not an accepted property on the `setCourseAssignment` input type (compile error).

- [ ] **Step 3: Implement the service change**

In `src/modules/learning/services/courses.ts`, change the type-only import on line 1 to:

```typescript
import type { Course, CourseAudience } from "@prisma/client";
```

Update `setCourseAssignment` (lines 67-82): add `audience` to the input and persist it on the course update:

```typescript
export async function setCourseAssignment(
  courseId: string,
  input: { departmentIds: string[]; assignToAll: boolean; audience: CourseAudience },
  actorId: string
): Promise<void> {
  await requireManager(actorId);
  await prisma.$transaction(async (tx) => {
    await tx.course.update({ where: { id: courseId }, data: { assignToAll: input.assignToAll, audience: input.audience } });
    await tx.courseDepartment.deleteMany({ where: { courseId } });
    if (input.departmentIds.length > 0) {
      await tx.courseDepartment.createMany({
        data: input.departmentIds.map((departmentId) => ({ courseId, departmentId })),
        skipDuplicates: true,
      });
    }
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.course_assign",
    entityType: "Course",
    entityId: courseId,
    after: input as unknown as Prisma.InputJsonValue,
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/learning/services/courses.test.ts`
Expected: PASS (existing + new test).

- [ ] **Step 5: Read the audience in the server action**

In `src/app/(app)/learning/manage/actions.ts`, add to the imports:

```typescript
import type { CourseAudience } from "@prisma/client";
```

Replace `setAssignmentAction` (lines 39-45) with:

```typescript
export async function setAssignmentAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  const departmentIds = formData.getAll("departmentIds").map(String);
  const raw = String(formData.get("audience") ?? "EVERYONE");
  const audience: CourseAudience = raw === "DIRECTORS" || raw === "VOLUNTEERS" ? raw : "EVERYONE";
  await setCourseAssignment(courseId, { departmentIds, assignToAll: formData.get("assignToAll") === "on", audience }, person.personId);
  revalidatePath(`/learning/manage/${courseId}`);
}
```

- [ ] **Step 6: Add the audience selector to the manage UI**

In `src/app/(app)/learning/manage/[courseId]/page.tsx`, add the Select import after the Checkbox import (line 7):

```typescript
import { Select } from "@/platform/ui/select";
```

Inside the assignment `<form>` (lines 42-54), add the selector between the "Assign to all departments" label (line 45) and the departments grid (line 46):

```tsx
          <label className="block text-sm">
            Audience
            <Select name="audience" defaultValue={course.audience} className="mt-1 max-w-xs">
              <option value="EVERYONE">Everyone</option>
              <option value="DIRECTORS">Directors only</option>
              <option value="VOLUNTEERS">Volunteers only</option>
            </Select>
          </label>
```

- [ ] **Step 7: Typecheck and lint**

Run:
```bash
npx tsc --noEmit
npx eslint src/modules/learning src/app/\(app\)/learning
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/modules/learning/services/courses.ts src/modules/learning/services/courses.test.ts "src/app/(app)/learning/manage/actions.ts" "src/app/(app)/learning/manage/[courseId]/page.tsx"
git commit -m "feat(learning): edit course audience in the manage UI"
```

---

### Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test` (with `TEST_DATABASE_URL` exported). The suite is large and serial; allow up to ~8 minutes.
Expected: all learning + rbac + onboarding tests pass. The known `schedule/services/builder.test.ts` `setPatientsBooked` flake is unrelated and passes in isolation; if it is the only failure, re-run that one file to confirm.

- [ ] **Step 2: Typecheck and lint the whole project**

Run:
```bash
npx tsc --noEmit
npx eslint .
```
Expected: both clean (exit 0).

- [ ] **Step 3: Smoke-check the assignment resolver end-to-end (optional manual)**

Confirm in the manage UI that a course saved with "Directors only" persists (reload the edit page shows the selector on DIRECTORS) and that the completion dashboard for that course lists only directors of the assigned department.

---

## Self-Review

**Spec coverage:**
- Schema (`CourseAudience` enum + `Course.audience` default EVERYONE, migration) → Task 1. ✓
- Matching rule (existential, kind tied to department-satisfying membership) → Task 2 engine + tests incl. mixed-membership cases. ✓
- Engine `coursesForMember` takes `{departmentId, kind}` + audience → Task 2. ✓
- Enrollment resolver threads kind + audience (drives My Courses, gate, play route) → Task 2. ✓
- Dashboard `getCourseCompletion` same audience filter → Task 3. ✓
- `setCourseAssignment` + manage UI audience selector → Task 4. ✓
- TDD coverage (engine unit, enrollment integration, dashboard integration, service) → Tasks 2-4. ✓
- Out of scope (no per-department-per-kind; sub-nav gating untouched) → respected (no such tasks). ✓

**Placeholder scan:** none; every step has concrete code/commands.

**Type consistency:** `CourseAudience` (`EVERYONE`/`DIRECTORS`/`VOLUNTEERS`) and `MembershipKind` (`DIRECTOR`/`VOLUNTEER`) used consistently; `audienceToKind`/`kindMatchesAudience`/`coursesForMember`/`MemberMembership` names match across engine, enrollment, and dashboard.
