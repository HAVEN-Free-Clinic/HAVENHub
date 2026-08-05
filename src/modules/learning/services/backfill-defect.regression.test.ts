import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getMyCourses, getCourseForLearner, persistScoCmi } from "./enrollment";
import { getCourseCompletion } from "./dashboard";
import { loadClearanceMap } from "@/modules/onboarding/services/clearance";

/**
 * Regression guard for the migration defect described in
 * `.superpowers/sdd/2026-07-31-learning-course-recurrence/final-findings.md`.
 *
 * An earlier draft of the recurrence migration backfilled only rows with a
 * non-null `completedAt`, leaving every IN_PROGRESS attempt at `termId = NULL`.
 * That was not an edge case: it is the state of anyone who had opened a course
 * and not finished it at deploy time. The consequences compounded:
 *
 *   1. A NULL termId does not deduplicate in the unique index, because
 *      Postgres treats NULLs as distinct.
 *   2. `resolveProgressTermId` filters `termId: { not: null }`, so it could not
 *      see the legacy row and created a SECOND row on the next commit.
 *   3. The unscoped ONCE readers collapse duplicates last-wins, and a btree
 *      index returns NULLs last, so the stale "incomplete" row won.
 *
 * The learner finished the course and stayed blocked forever, because every
 * later commit wrote the other row. That is the same class of defect this whole
 * branch exists to remove.
 *
 * The fix makes the bad state unrepresentable rather than merely unreached:
 * every row is backfilled to a term, the column is NOT NULL, and the foreign
 * key is ON DELETE RESTRICT so nothing can put a NULL back.
 */
beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

async function seed() {
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const learner = await prisma.person.create({
    data: { name: "Lee", status: "ACTIVE", contactEmail: "lee@x.edu", phone: "555-0100" },
  });
  const term = await prisma.term.create({
    data: {
      code: "SU26", name: "Summer 2026", status: "ACTIVE",
      startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"),
    },
  });
  await prisma.termMembership.create({
    data: { personId: learner.id, termId: term.id, departmentId: dept.id, status: "ACTIVE", kind: "VOLUNTEER" },
  });
  const course = await prisma.course.create({
    data: {
      title: "Intro",
      recurrence: "ONCE",
      scormEntryHref: "index.html",
      scormVersion: "1.2",
      scormScos: [{ id: "sco-0", title: "Intro", href: "index.html" }],
      departments: { create: [{ departmentId: dept.id }] },
    },
  });
  return { dept, learner, term, course };
}

it("a null-term progress row cannot be created at all, so the duplicate-row lockout is unrepresentable", async () => {
  const { learner, course } = await seed();

  // The whole defect rested on this row being storable. It is not.
  await expect(
    prisma.courseProgress.create({
      data: {
        personId: learner.id, courseId: course.id,
        // @ts-expect-error termId is non-nullable by design; this asserts the DB agrees.
        termId: null,
        status: "IN_PROGRESS", lessonStatus: "incomplete",
      },
    }),
  ).rejects.toThrow();
});

it("a legacy in-progress attempt is adopted and updated in place, not forked into a second row", async () => {
  const { learner, term, course } = await seed();

  // What the fixed migration leaves behind for an attempt that had no
  // completedAt: the ACTIVE term, which is exactly what the write path would
  // resolve on the very next commit. So the commit below must UPDATE this row.
  await prisma.courseProgress.create({
    data: {
      personId: learner.id, courseId: course.id, termId: term.id,
      status: "IN_PROGRESS", lessonStatus: "incomplete",
    },
  });

  await persistScoCmi(learner.id, course.id, "sco-0", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });

  const rows = await prisma.courseProgress.findMany({
    where: { personId: learner.id, courseId: course.id },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("COMPLETE");
});

it("a learner who finished a ONCE course reads COMPLETE on every reader", async () => {
  const { learner, term, course } = await seed();

  await prisma.courseProgress.create({
    data: {
      personId: learner.id, courseId: course.id, termId: term.id,
      status: "IN_PROGRESS", lessonStatus: "incomplete",
    },
  });
  await persistScoCmi(learner.id, course.id, "sco-0", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });

  const viewer = await prisma.person.create({ data: { name: "Viewer", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Learning Viewer", grants: { create: [{ permission: "learning.view_progress" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: viewer.id, roleId: role.id } });

  // All four readers, because they collapse rows by different rules and the
  // original defect showed up as two of them disagreeing with the other two.
  const myCourses = await getMyCourses(learner.id);
  const learnerCourse = await getCourseForLearner(learner.id, course.id);
  const completion = await getCourseCompletion(course.id, viewer.id);
  const clearance = await loadClearanceMap([learner.id], term.id);

  expect(myCourses.find((r) => r.id === course.id)?.status).toBe("COMPLETE");
  expect(learnerCourse.status).toBe("COMPLETE");
  expect(completion.find((r) => r.personId === learner.id)?.status).toBe("COMPLETE");
  expect(clearance.get(learner.id)?.tasks.find((t) => t.key === "learning")?.state).toBe("COMPLETE");
});
