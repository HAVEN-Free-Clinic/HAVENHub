# Learning course audience: target by director/volunteer status

## Motivation

Course assignment can currently scope a course only by department (`Course.departments`) or org-wide (`Course.assignToAll`); it has no notion of membership kind. After [issue #65](https://github.com/HAVEN-Free-Clinic/HAVENHub/pull/120) granted directors `learning.access`, directors are now assigned every department / `assignToAll` course, including ones authored for volunteers only. Admins need to target a course at **directors, volunteers, or everyone**.

`TermMembership.kind` (`MembershipKind { DIRECTOR, VOLUNTEER }`) already records each membership's kind, but assignment ignores it. Kind is **per-department**: one person can be a volunteer in one department and a director in another.

## Decision

Add a single **per-course audience**: each course targets `EVERYONE`, `DIRECTORS`, or `VOLUNTEERS`. The audience composes with the existing department / assign-to-all scoping rather than replacing it.

## Matching rule

The audience check is tied to the *same* membership that satisfies the department scope. A course is assigned to a person iff **there exists** an active `TermMembership` `m` (in the active term) such that:

```
(course.assignToAll OR m.departmentId ∈ course.departments)
  AND
(course.audience == EVERYONE OR m.kind == course.audience)
```

Worked cases:

| Course | Person | Assigned? |
| --- | --- | --- |
| all depts + Volunteers | volunteer in any dept | yes |
| all depts + Directors | director in any dept | yes |
| dept A + Directors | director in dept A | yes |
| dept A + Directors | volunteer in dept A (director in dept B) | **no** (their dept-A membership is volunteer) |
| all depts + Directors | volunteer in A, director in B | yes (they direct B) |
| dept A + Everyone | any membership in dept A | yes (current behavior) |

`EVERYONE` reproduces today's behavior exactly, so existing courses are unaffected.

## Schema

Add to `Course`:

```prisma
enum CourseAudience {
  EVERYONE
  DIRECTORS
  VOLUNTEERS
}

model Course {
  // ...
  audience CourseAudience @default(EVERYONE)
}
```

Migration adds the column with default `EVERYONE`; existing rows inherit it, so no data backfill is needed and current behavior is preserved.

## Touch points

1. **Engine (`src/modules/learning/engine/assignment.ts`).** `coursesForMember` takes memberships as `{ departmentId, kind }[]` (not bare department ids) and each course gains an `audience`. Apply the existential rule. This is pure, no-DB, fully unit-testable.
2. **Enrollment resolver (`src/modules/learning/services/enrollment.ts`).** `memberDepartmentIds` → return `{ departmentId, kind }` rows; `assignedCourseIds` selects `Course.audience` and passes it through. Drives My Courses, the onboarding gate, and the play-route guard, so all stay consistent automatically.
3. **Completion dashboard (`src/modules/learning/services/dashboard.ts`).** `getCourseCompletion` independently lists "every active member of an assigned department"; it must apply the same audience filter against `m.kind`, or a volunteer-only course would list directors as perpetually NOT_STARTED (the very problem #65 fixed).
4. **Assignment service (`src/modules/learning/services/courses.ts`).** `setCourseAssignment` input gains `audience: CourseAudience`; persist it on the course. `getCourseForEdit` already returns the course (includes the new field).
5. **Manage UI (`src/app/(app)/learning/manage/[courseId]/page.tsx` + `actions.ts`).** Add an audience selector (Everyone / Directors only / Volunteers only) to the Assignment form; `setAssignmentAction` reads it from the form data.

## Testing (TDD)

- **Engine unit tests** (`assignment.test.ts`): the rule across `EVERYONE`/`DIRECTORS`/`VOLUNTEERS` × `assignToAll`/department, including the mixed-membership cases in the table above.
- **Enrollment integration** (`enrollment.test.ts`): a director-only and a volunteer-only member each get only the courses whose audience matches; `EVERYONE` courses go to both.
- **Dashboard integration** (`dashboard.test.ts`): `getCourseCompletion` for a `DIRECTORS` course lists directors of the assigned dept and excludes volunteers.

## Out of scope

- No per-department-per-kind targeting (e.g. directors in A but volunteers in B on one course). A single per-course audience is sufficient for the stated need.
- The learning sub-nav tab gating noted in the #65 spec is still separate and unchanged.
