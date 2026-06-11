# Learning — Asynchronous Training Module

**Date:** 2026-06-10
**Status:** Approved design, ready for implementation planning

## Summary

A new first-class `learning` module that delivers self-paced, asynchronous
volunteer training as department-assigned courses. Each course is an ordered
list of modules; a module is either a link out to externally-hosted content
(a video or a document) or a native in-app quiz. Volunteers work through the
courses assigned to their department; managers author courses and watch a
per-department completion dashboard.

This was originally framed as "integrate Moodle." Moodle was rejected: it is a
separate PHP + MySQL application that cannot run inside the Next.js/Vercel Hub,
and standing up, hosting, patching, and securing a second app — adding HIPAA and
security surface — is unjustified for content that is only video, reading, and
quizzes (no SCORM/xAPI). Building natively in the Hub reuses one codebase, one
auth, one database, and the existing department model.

## Requirements (from brainstorming)

- **Goal:** asynchronous self-paced training. Moodle not required.
- **Content types:** videos, reading/documents, quizzes. No SCORM/xAPI.
- **Structure:** role/department tracks — courses assigned by department.
- **Relationship to existing per-term training gate:** none. This is a separate
  system and does not touch term clearance (the existing `/training` makeup quiz
  in the recruitment module is untouched).
- **Authoring:** hybrid. Admins manage which courses exist, their modules, and
  department assignments. Video/reading content is authored externally (e.g.
  Google Docs, hosted video) and referenced by URL. Quizzes are native because
  they need grading and pass control.
- **Admin needs:** per-department completion dashboard, and quiz pass control
  (pass percentage + attempt limits) gating course completion.

## Non-goals (YAGNI for v1)

- No certificates of completion.
- No SCORM/xAPI engine.
- No in-app rich-text lesson authoring (content lives externally, by link).
- No sequential module gating (free order in v1; sequential noted as future).
- No integration with term clearance / the recruitment training cycle.

## Architecture

Registered as a module in `src/platform/modules/registry.ts`, the same pattern
as `recruitment` and `volunteers`.

- **Module id:** `learning` → routes under `/learning`, permission namespace
  `learning.*`.
- **Title:** "Learning". The existing `/training` route (per-term clearance
  quiz) keeps its name to avoid collision.
- **Code layout:**
  - `src/modules/learning/services/*` — course/assignment/progress/dashboard
    services (DB access), mirroring `src/modules/recruitment/services/*`.
  - `src/modules/learning/engine/*` — pure logic (course-completion
    computation, assignment resolution) with unit tests.
  - `src/app/learning/*` — routes (`page.tsx`, `actions.ts`, nested routes).

## Data model (new Prisma models)

```prisma
enum CourseModuleKind     { VIDEO  DOCUMENT  QUIZ }
enum CourseProgressStatus { IN_PROGRESS  COMPLETE }

model Course {
  id          String   @id @default(cuid())
  title       String
  description String?
  isActive    Boolean  @default(true)
  assignToAll Boolean  @default(false)   // org-wide course (all departments)
  position    Int      @default(0)       // catalog ordering
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  modules     CourseModule[]
  departments CourseDepartment[]
  progress    CourseProgress[]
}

model CourseDepartment {                  // assignment: a course → a department
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
  description String?           // optional instructions shown to the volunteer
  url         String?           // VIDEO/DOCUMENT external link
  questions   Json?             // QUIZ: [{ key, label, options, correctValue }]
  passPercent Int?              // QUIZ: override; else from settings
  maxAttempts Int?              // QUIZ: override; else from settings
  course      Course           @relation(fields: [courseId], references: [id], onDelete: Cascade)
  progress    ModuleProgress[]
  @@unique([courseId, position])
}

model CourseProgress {                    // per person, per course
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

model ModuleProgress {                     // per person, per module
  id          String              @id @default(cuid())
  personId    String
  moduleId    String
  completedAt DateTime?
  locked      Boolean             @default(false)   // quiz attempt lock
  person      Person              @relation(fields: [personId], references: [id], onDelete: Cascade)
  module      CourseModule        @relation(fields: [moduleId], references: [id], onDelete: Cascade)
  attempts    CourseQuizAttempt[]
  @@unique([personId, moduleId])
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

`Course`, `CourseDepartment`, `CourseProgress` require back-relations added to
`Department` and `Person`. The `Course`/`CourseModule` + `CourseProgress`/
`ModuleProgress`/`CourseQuizAttempt` shape deliberately mirrors the proven
`VolunteerTraining` + `QuizAttempt` pattern.

## Assignment by department

A volunteer's assigned courses are active courses where either:

- `assignToAll` is true, or
- a `CourseDepartment` row matches a department the person is an **active member
  of in the current term** (via `TermMembership`, `status = ACTIVE`).

A course that is active but has no department rows and `assignToAll = false` is
treated as a draft and shown to no one. Assignment resolution is a pure function
(`engine/`) over the person's current-term memberships and the course's
assignment rows, unit-tested independently of the DB.

## Permissions (`learning.*`)

- `learning.access` — see the module and complete assigned courses. Granted
  broadly to volunteers (base role), analogous to how rank-and-file access works
  elsewhere.
- `learning.manage_courses` — create/edit courses, modules, and assignments.
- `learning.view_progress` — view the completion dashboard.

Module manifest: `accessPermission: "learning.access"`, `permissions:
["learning.access", "learning.manage_courses", "learning.view_progress"]`.
Learner routes guard on `learning.access`; the manage and dashboard routes guard
on their respective manage permissions and are hidden from the module nav for
users without them. Course create/edit/assign actions and quiz-lock resets write
to the existing `AuditLog`.

## Volunteer flow

- `/learning` — a card per assigned course showing status (Not started / In
  progress / Complete) and `x / y modules` progress.
- `/learning/[courseId]` — the ordered module list:
  - **VIDEO / DOCUMENT:** title, optional description, an **Open** link
    (`target=_blank`, `rel=noreferrer`) to the external `url`, and a **Mark
    complete** button (honor-system, standard for externally-hosted content).
  - **QUIZ:** the same quiz-form UI the existing `/training` page uses, graded
    on submit with the quiz's `passPercent` and `maxAttempts`; locking on
    exhausted attempts identical to the current makeup-quiz behavior.
- A course flips to `COMPLETE` (set `completedAt`) when every module has a
  completed `ModuleProgress` and every quiz module is passed. v1 is **free
  order** — modules can be done in any order. Sequential unlocking is a future
  option.

## Quiz handling and reuse

Quizzes reuse the existing pure grader. **Targeted refactor:** lift `gradeQuiz`
from `src/modules/recruitment/engine/quiz-grading.ts` to a shared
`src/platform/quiz/grading.ts`, and update `recruitment` to import it from
there, so `learning` does not reach into `recruitment` internals. Behavior is
unchanged; recruitment's existing tests continue to cover it (move or re-point
the test alongside the moved module).

Default `passPercent` and `maxAttempts` come from the existing settings registry
(configurable, admin-editable), with optional per-quiz override on
`CourseModule`. A manager can reset a locked quiz (clear `locked`), matching the
existing training reset behavior.

## Admin flow

- **Manage** (`/learning/manage`, guarded by `learning.manage_courses`):
  - List, create, edit, activate/deactivate courses.
  - Add, reorder, and edit modules — set kind + `url` for VIDEO/DOCUMENT, or
    build the quiz (`questions`, `passPercent`, `maxAttempts`) for QUIZ.
  - Assign departments, or set `assignToAll`.
- **Completion dashboard** (`/learning/dashboard`, guarded by
  `learning.view_progress`):
  - Per-course × per-department matrix of who is complete vs. outstanding,
    filterable by department, course, and term.
  - Reset locked quizzes from a person's row.

## Testing

Service- and engine-level vitest tests matching `recruitment/services/*.test.ts`
and `recruitment/engine/*.test.ts`, using the `resetDb` harness:

- Assignment resolution (department membership → assigned courses, including
  `assignToAll` and draft courses).
- Course-completion computation (all modules complete + all quizzes passed).
- Quiz grading and attempt locking (reusing the moved `gradeQuiz`).
- Dashboard aggregation (complete vs. outstanding per course/department).

End-to-end (Playwright) coverage is deferred to a follow-up.

## Open decisions deferred to the plan

- Exact nav-item permission filtering mechanism (hide manage/dashboard nav
  without the permission) — confirm whether the manifest nav model already
  supports per-item gating or needs a small addition.
- Settings keys for default `passPercent` / `maxAttempts`.
