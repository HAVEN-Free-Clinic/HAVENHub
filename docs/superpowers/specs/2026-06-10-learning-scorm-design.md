# Learning: SCORM packages as courses

**Date:** 2026-06-10
**Status:** Approved design
**Supersedes:** `2026-06-10-learning-async-training-design.md` (the native video/document/quiz module approach). This design reshapes the unmerged `feat/learning-async-training` branch rather than layering on top of it.

## Summary

HAVEN authors self-paced training as SCORM 1.2 packages in eXeLearning and hosts them inside HAVEN Hub. Each course is one uploaded SCORM package. The hub stores the unzipped package privately, serves it back same-origin to a learner in an iframe, runs a SCORM 1.2 runtime that the package talks to, and records completion (and an optional score) per learner. Admins assign courses to departments and watch a completion dashboard.

This replaces the native module content from the earlier design. The course/assignment/dashboard **shell** is kept; the native `VIDEO` / `DOCUMENT` / `QUIZ` module kinds and native quizzes are removed.

## Decisions (from brainstorming)

1. **Replace content, keep the shell.** Keep `Course`, department assignment, and the completion dashboard. Drop native module kinds and native quizzes.
2. **Course = one SCORM package.** No module list. A course *is* its uploaded package. eXeLearning bundles pages + quizzes into the single package.
3. **SCORM 1.2.** Read completion from `cmi.core.lesson_status`. (2004 is out of scope.)
4. **Score is optional.** When a package uses eXeLearning's "Automatically save the score" setting it reports `cmi.core.score.raw`; the hub stores and shows it. Packages that don't report a score still work and show plain "Complete."
5. **Runtime via `scorm-again`** (MIT). The hub installs its `Scorm12API` as `window.API`; we provide persistence. No hand-rolled CMI model, no external SCORM cloud.

## Non-goals / explicit constraints

- **Fast-forward / seek prevention is a content-authoring concern, not a hub feature.** SCORM only reports status; it cannot police video position. Enforcement is done **inside eXeLearning**: embed video with the seek bar disabled and gate progression (Next button / quiz) on the video's `ended` event, so the package only reports `completed` after a genuine play-through. This deters casual skipping. It is **not tamper-proof** - a determined user with dev tools can forge the completion call, which is a fundamental limit of any browser-based SCORM/LMS. A hub-side "reject impossibly-fast completion" backstop is possible later but is **not** in this scope.
- **Pass marks and attempt limits live in eXeLearning now**, not the hub. The old `learning.defaultQuizPassPercent` / `learning.defaultQuizMaxAttempts` settings are removed.
- SCORM 2004, AICC, xAPI/cmi5, and multi-package courses are out of scope.

## Architecture

### Runtime choice

A SCORM package is static HTML/JS that, on load, walks the window tree looking for an `API` object and calls `LMSInitialize`, `LMSGetValue`, `LMSSetValue`, `LMSCommit`, `LMSFinish`. Something must *be* that object and persist what it receives.

We use **`scorm-again`'s `Scorm12API`**, instantiated on the learner page as `window.API`, seeded with the learner's saved CMI, persisting on commit/finish. Rejected: hand-rolling the CMI model (long bug tail against picky eXeLearning content) and SCORM Cloud / external LMS (sends training data off-platform, adds cost + a third-party dependency).

### Same-origin serving (mandatory)

The package runs in an `iframe`. The SCORM API lookup walks `window.parent`; if the iframe is a different origin than the host page it throws a cross-origin `SecurityError` and SCORM fails. Vercel Blob objects are also **private** (no usable public URL). Both facts force the same solution: serve package files through a **same-origin Next.js route handler** that reads bytes via the existing `getObject` storage abstraction.

### Storage

Reuse `src/platform/storage.ts` (`putObject` / `getObject` / `deleteObject`), which already backs onto Vercel Blob (private) on Vercel and local disk in dev/CI/test. Package files are stored under the deterministic key prefix `scorm/<courseId>/<relpath>`. No new storage infrastructure.

## Data model

Reshape the schema on the unmerged branch. Because the earlier `learning_module` migration may already be applied to the shared test DB and the demo DB, this ships as a **new forward-only migration** that drops the removed tables/columns and adds the SCORM fields (we do not edit the prior migration).

### Keep

- **`Course`** - `id`, `title`, `description`, `isActive`, `assignToAll`, `position`, timestamps.
- **`CourseDepartment`** - course-to-department assignment (unchanged).
- **`CourseProgress`** - one row per (person, course).

### Add to `Course`

- `scormEntryHref String?` - launch file from the manifest, e.g. `index.html`. `null` = draft (no package uploaded yet).
- `scormVersion String?` - e.g. `"1.2"`.
- `scormUploadedAt DateTime?` - when the current package was ingested.

### Extend `CourseProgress`

Holds SCORM state for resume + reporting:

- `lessonStatus String?` - raw `cmi.core.lesson_status`.
- `scoreRaw Int?` - `cmi.core.score.raw` when reported; nullable.
- `suspendData String?` (`@db.Text`) - `cmi.suspend_data` (can be large).
- `lessonLocation String?` - `cmi.core.lesson_location`.
- Existing `status` (`IN_PROGRESS` / `COMPLETE`) + `completedAt`, now **derived** from `lessonStatus`.

### Remove

- Models `CourseModule`, `ModuleProgress`, `CourseQuizAttempt`.
- Enum `CourseModuleKind`.
- Settings `learning.defaultQuizPassPercent`, `learning.defaultQuizMaxAttempts`.
- Back-relations and learning-side imports tied to the above.

### Keep untouched

- `@/platform/quiz/grading` (`gradeQuiz`) - recruitment still depends on it. Only the learning module stops importing it.

### Status derivation

| `cmi.core.lesson_status` | Hub `status` |
| --- | --- |
| `passed`, `completed` | `COMPLETE` |
| `failed`, `incomplete`, `browsed` | `IN_PROGRESS` |
| `not attempted` / none recorded | (no row, or) Not started |

`completedAt` is stamped once, the first time `status` becomes `COMPLETE`, and preserved across later commits.

## Components and flows

### Ingest (admin, `learning.manage_courses`)

1. Admin creates a course (title/description), assigns departments, uploads a `.zip`.
2. Server action unzips in memory with **`fflate`** (tiny, no native deps, Vercel-safe).
3. Parse `imsmanifest.xml`: find the launch resource's `href` and the SCORM version. **Reject** if there is no manifest or no launchable resource.
4. Sanitize every entry path (reject `..` and absolute paths), then `putObject` each file under `scorm/<courseId>/<relpath>` with a content-type inferred from the extension.
5. Set `scormEntryHref`, `scormVersion`, `scormUploadedAt` on the course; `recordAudit`.
6. Re-upload (replace): delete the existing `scorm/<courseId>/` files first, then write the new set. Existing learner `CourseProgress` is left intact (admin can Reset individuals if needed).
7. Guardrails: cap total unzipped size and file count to bound abuse.

### Serve (route handler)

`GET /learning/play/[courseId]/[...path]`:

- `requireModuleAccess("learning")`, then authorize: the learner is assigned the course (via `coursesForMember`) **or** holds `learning.manage_courses` (admin preview).
- Map `path` to the storage key `scorm/<courseId>/<path>`; refuse traversal; `getObject`; stream with the inferred content-type; `404` when missing.
- `Cache-Control: private`. Content is access-gated per request.

### Learner

- `/learning` - assigned courses with status badges. (Drops module counts.)
- `/learning/[courseId]` - the player page:
  - Server side: load the course + the learner's `CourseProgress`; if `scormEntryHref` is null show "not available yet."
  - Client component: install `window.API` (`Scorm12API`) **before** the iframe loads, seeded with saved CMI (`lessonStatus`, `lessonLocation`, `suspendData`, score) so the learner resumes; render an `iframe` whose `src` is `/learning/play/<courseId>/<entryHref>`; on every `LMSCommit` / `LMSFinish`, POST the CMI to a server action that persists fields and derives `status` + `completedAt`.
  - Show a "You have completed this course" banner when `status === COMPLETE`.

### Manage (admin)

- `/learning/manage` - list + create courses.
- `/learning/manage/[courseId]` - edit title/description/active, department assignment, and the SCORM **upload/replace** control; show current package status (uploaded? entry href, version, uploaded-at).

### Dashboard (admin, `learning.view_progress`)

- `/learning/dashboard` - per selected course, learners (by assigned department) with **Not started / In progress / Complete**, completion date, and **score when present** ("Passed - 90%").
- **Reset** action clears a learner's `CourseProgress` row so they can retake. (Drops the old per-module quiz-lock/reset logic.)

### Permissions / registry / nav

Unchanged: `learning.access`, `learning.manage_courses`, `learning.view_progress`; the module manifest and its nav tabs stay as-is.

## Engine / service boundaries

- `engine/manifest.ts` (pure) - parse `imsmanifest.xml` → `{ entryHref, version }`; throw a validation error on missing manifest / no launchable resource. Unit-tested without a DB.
- `engine/status.ts` (pure) - `lesson_status` (+ optional score) → `{ status, scoreRaw }`. Unit-tested.
- `services/packages.ts` - ingest (unzip, validate via engine, store, set course fields, audit), replace, delete.
- `services/courses.ts` - course CRUD + department assignment (trimmed from the PR #28 version; no module/quiz CRUD).
- `services/enrollment.ts` - `getMyCourses`, `getCourseForLearner`, `persistCmi` (derive + write progress).
- `services/dashboard.ts` - `listCoursesForDashboard`, `getCourseCompletion` (derive rows), `resetCourseProgress`.

## Error handling

- Ingest validation failures (no manifest, no SCO, oversized, bad paths) surface as a `LearningValidationError` shown on the manage page; nothing is stored.
- Serve route returns `404` for missing files / unauthorized course access (no enumeration of what exists), refuses path traversal.
- `persistCmi` is idempotent: re-commits update state; `completedAt` is stamped once and preserved.

## Testing

- **Engine units:** manifest parsing (finds launch href + version; rejects invalid/missing); status derivation across all `lesson_status` values; score extraction (present / absent).
- **Service + route tests** against the shared test DB, using a tiny SCORM 1.2 fixture zip built **in-memory** with `fflate` (a minimal `imsmanifest.xml` + one `index.html` - no binary fixture checked in):
  - ingest stores files under the prefix and sets `scormEntryHref` / `scormVersion`;
  - replace deletes the old files then writes the new set;
  - assignment (assignToAll vs department intersection) controls who sees the course;
  - `persistCmi` updates progress, derives `status`, stamps `completedAt` once;
  - dashboard derives rows + score;
  - reset clears progress;
  - route handler serves a stored file, `404`s a missing one, blocks traversal, blocks an unassigned learner.

## New dependencies

- `scorm-again` - SCORM 1.2 runtime.
- `fflate` - in-memory unzip (and test-fixture zip).

## Migration / rollout notes

- New forward-only Prisma migration: drop `CourseModule`, `ModuleProgress`, `CourseQuizAttempt`, the `CourseModuleKind` enum; add the `Course` SCORM columns and `CourseProgress` SCORM columns. Prepend/adjust the test-DB truncate list accordingly.
- Remove the two learning quiz settings from the settings registry.
- This work continues on `feat/learning-async-training` (PR #28), reshaping it before merge to `main`.
