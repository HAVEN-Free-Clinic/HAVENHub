# Learning SCORM Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native video/document/quiz learning content with self-contained SCORM 1.2 packages (authored in eXeLearning): each course is one uploaded package, stored privately, served same-origin to a learner in an iframe, driven by a SCORM runtime that records completion + optional score.

**Architecture:** Keep the course/department-assignment/completion-dashboard shell from the unmerged `feat/learning-async-training` branch; drop the module/quiz machinery. Admins upload a `.zip`; the server unzips it (`fflate`), reads the launch file from `imsmanifest.xml` (`fast-xml-parser`), and stores every file under `scorm/<courseId>/<relpath>` via the existing `putObject` storage abstraction. A Next.js route handler streams those files back same-origin so the SCORM API (provided by `scorm-again`'s `Scorm12API` on the player page) is reachable across the iframe boundary. The runtime persists `cmi.core.lesson_status` / `score.raw` / `lesson_location` / `suspend_data` to `CourseProgress`, from which completion is derived.

**Tech Stack:** Next.js 16 App Router (Server Components, Server Actions, route handlers), React 19, TypeScript, Prisma 6 / PostgreSQL (Neon), Vitest (shared remote test DB, `fileParallelism: false`). New deps: `scorm-again`, `fflate`, `fast-xml-parser`.

**Working directory:** the `feat/learning-async-training` worktree (`.claude/worktrees/fix+hipaa-cert-blob-storage`). All paths below are repo-relative.

**Spec:** `docs/superpowers/specs/2026-06-10-learning-scorm-design.md`

---

## File map

**Create**
- `src/modules/learning/engine/manifest.ts` — pure `imsmanifest.xml` parser → `{ entryHref, version }`.
- `src/modules/learning/engine/manifest.test.ts`
- `src/modules/learning/engine/status.ts` — pure `lesson_status` (+score) → derived status.
- `src/modules/learning/engine/status.test.ts`
- `src/modules/learning/services/packages.ts` — ingest/replace a SCORM zip.
- `src/modules/learning/services/packages.test.ts`
- `src/modules/learning/services/test-fixtures.ts` — build a minimal SCORM 1.2 zip in-memory for tests.
- `src/app/learning/play/[courseId]/[...path]/route.ts` — same-origin file server for package assets.
- `src/app/learning/[courseId]/ScormPlayer.tsx` — client component hosting `window.API`.

**Modify**
- `package.json` — add the three deps.
- `prisma/schema.prisma` — reshape `Course` + `CourseProgress`, drop module/quiz models + enum.
- `src/platform/storage.ts` — add `deletePrefix`.
- `src/platform/test/db.ts` — trim the TRUNCATE list.
- `src/platform/settings/registry.ts` — remove the two `learning.*` quiz settings.
- `src/modules/learning/services/courses.ts` (+ `courses.test.ts`) — drop module CRUD.
- `src/modules/learning/services/enrollment.ts` (+ `enrollment.test.ts`) — `persistCmi`, SCORM-shaped reads.
- `src/modules/learning/services/dashboard.ts` (+ `dashboard.test.ts`) — SCORM-derived rows, `resetCourseProgress`.
- `src/app/learning/manage/actions.ts` — `uploadPackageAction` replaces `addModuleAction`.
- `src/app/learning/actions.ts` — `persistCmiAction` replaces module-complete/quiz actions.
- `src/app/learning/dashboard/actions.ts` — `resetCourseProgressAction`.
- `src/app/learning/page.tsx`, `src/app/learning/[courseId]/page.tsx`, `src/app/learning/manage/page.tsx`, `src/app/learning/manage/[courseId]/page.tsx`, `src/app/learning/dashboard/page.tsx` — new UI.

**Delete**
- `src/modules/learning/engine/completion.ts` + `completion.test.ts`
- `src/modules/learning/services/types.ts`

**Untouched (do not edit):** `src/platform/quiz/grading.ts` (recruitment depends on it), `src/modules/learning/engine/assignment.ts` + `assignment.test.ts`, `src/modules/learning/services/errors.ts`, `src/platform/modules/registry.ts` (the learning manifest + nav stay as-is).

---

## Task 1: Dependencies, schema reshape, migration, settings cleanup

**Files:**
- Modify: `package.json`
- Modify: `prisma/schema.prisma`
- Modify: `src/platform/test/db.ts`
- Modify: `src/platform/settings/registry.ts:100-119`

- [ ] **Step 1: Install the three runtime dependencies**

Run: `npm install scorm-again fflate fast-xml-parser`
Expected: all three added to `package.json` dependencies, `package-lock.json` updated.

- [ ] **Step 2: Reshape the `Course` model**

In `prisma/schema.prisma`, replace the `Course` model with (note: `modules` relation removed, three `scorm*` fields added):

```prisma
model Course {
  id              String             @id @default(cuid())
  title           String
  description     String?
  isActive        Boolean            @default(true)
  /// When true, the course is assigned to every department (org-wide).
  assignToAll     Boolean            @default(false)
  /// Ordering in the catalog / management list.
  position        Int                @default(0)
  /// Launch file from imsmanifest.xml (e.g. "index.html"). Null = no package uploaded yet (draft).
  scormEntryHref  String?
  /// SCORM version string, e.g. "1.2".
  scormVersion    String?
  /// When the current package was ingested.
  scormUploadedAt DateTime?
  createdAt       DateTime           @default(now())
  updatedAt       DateTime           @updatedAt
  departments     CourseDepartment[]
  progress        CourseProgress[]
}
```

- [ ] **Step 3: Reshape the `CourseProgress` model**

Replace the `CourseProgress` model with (adds the four SCORM state columns):

```prisma
model CourseProgress {
  id             String               @id @default(cuid())
  personId       String
  courseId       String
  status         CourseProgressStatus @default(IN_PROGRESS)
  completedAt    DateTime?
  /// Raw cmi.core.lesson_status reported by the package.
  lessonStatus   String?
  /// cmi.core.score.raw when reported; null otherwise.
  scoreRaw       Int?
  /// cmi.suspend_data — can be large.
  suspendData    String?              @db.Text
  /// cmi.core.lesson_location for resume.
  lessonLocation String?
  person         Person               @relation(fields: [personId], references: [id], onDelete: Cascade)
  course         Course               @relation(fields: [courseId], references: [id], onDelete: Cascade)

  @@unique([personId, courseId])
  @@index([courseId])
}
```

- [ ] **Step 4: Delete the module/quiz models and enum**

Delete these entirely from `prisma/schema.prisma`: the `CourseModule` model, the `ModuleProgress` model, the `CourseQuizAttempt` model, and the `enum CourseModuleKind { ... }`. Keep `enum CourseProgressStatus`.

- [ ] **Step 5: Fix the back-relations**

In the `Person` model, delete the `moduleProgress ModuleProgress[]` relation line (keep `courseProgress CourseProgress[]`). Confirm the `Department` model still has `courseDepartments CourseDepartment[]` (unchanged).

- [ ] **Step 6: Generate the migration**

Run: `npm run db:migrate -- --name learning_scorm`
Expected: a new folder `prisma/migrations/<timestamp>_learning_scorm/migration.sql` containing `DROP TABLE "CourseQuizAttempt"`, `DROP TABLE "ModuleProgress"`, `DROP TABLE "CourseModule"`, `DROP TYPE "CourseModuleKind"`, and `ALTER TABLE "Course"` / `"CourseProgress"` adding the new columns. Prisma client regenerates. (If the command prompts about data loss, accept — this branch is unmerged and the tables are empty in dev.)

- [ ] **Step 7: Trim the test-DB TRUNCATE list**

In `src/platform/test/db.ts`, the TRUNCATE statement (line ~8) currently lists `"CourseQuizAttempt", "ModuleProgress", "CourseProgress", "CourseDepartment", "CourseModule", "Course"`. Replace those six identifiers with the three that remain, in FK-safe order:

```
"CourseProgress", "CourseDepartment", "Course",
```

(Remove `"CourseQuizAttempt"`, `"ModuleProgress"`, `"CourseModule"`.)

- [ ] **Step 8: Remove the two learning quiz settings**

In `src/platform/settings/registry.ts`, delete the two `define<number>({ ... })` blocks for `key: "learning.defaultQuizPassPercent"` and `key: "learning.defaultQuizMaxAttempts"` (lines 100–119, the block starting at the `define<number>({` on line 100 through the `}),` on line 119). The `compliance.escalationThreshold` block above and the `email.sender` block below stay.

- [ ] **Step 9: Verify schema + types compile**

Run: `npx prisma generate && npx tsc --noEmit 2>&1 | head -40`
Expected: prisma generates; tsc will still report errors in the learning services/pages that reference removed models — that is expected at this stage. Confirm there are NO errors in `prisma/schema.prisma` itself, `src/platform/test/db.ts`, or `src/platform/settings/registry.ts`.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json prisma/ src/platform/test/db.ts src/platform/settings/registry.ts
git commit -m "feat(learning): reshape schema for SCORM packages; add scorm-again/fflate/fast-xml-parser"
```

---

## Task 2: Manifest parser engine (pure, TDD)

**Files:**
- Create: `src/modules/learning/engine/manifest.ts`
- Test: `src/modules/learning/engine/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/learning/engine/manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseManifest, ManifestError } from "./manifest";

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MAN-1" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>Course</title>
      <item identifier="ITEM-1" identifierref="RES-1"><title>Lesson</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/>
    </resource>
  </resources>
</manifest>`;

describe("parseManifest", () => {
  it("returns the launch href and version from the default organization", () => {
    expect(parseManifest(MANIFEST)).toEqual({ entryHref: "index.html", version: "1.2" });
  });

  it("falls back to the first resource with an href when items lack identifierref", () => {
    const xml = MANIFEST.replace('identifierref="RES-1"', "");
    expect(parseManifest(xml).entryHref).toBe("index.html");
  });

  it("throws ManifestError when there is no launchable resource", () => {
    const xml = MANIFEST.replace(/<resources>[\s\S]*<\/resources>/, "<resources></resources>");
    expect(() => parseManifest(xml)).toThrow(ManifestError);
  });

  it("throws ManifestError on unparseable input", () => {
    expect(() => parseManifest("not xml at all")).toThrow(ManifestError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/learning/engine/manifest.test.ts`
Expected: FAIL — `parseManifest` not found.

- [ ] **Step 3: Implement the parser**

Create `src/modules/learning/engine/manifest.ts`:

```ts
import { XMLParser } from "fast-xml-parser";

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export type ParsedManifest = {
  /** Launch file, relative to the package root (e.g. "index.html"). */
  entryHref: string;
  /** SCORM schema version, e.g. "1.2". */
  version: string;
};

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Depth-first search for the first item carrying an identifierref. */
function firstItemRef(item: Record<string, unknown>): string | null {
  const ref = item["@_identifierref"];
  if (typeof ref === "string" && ref) return ref;
  for (const child of toArray(item["item"] as Record<string, unknown>)) {
    const found = firstItemRef(child);
    if (found) return found;
  }
  return null;
}

/**
 * Parse an imsmanifest.xml string into the launch href + version.
 *
 * Resolution: pick the default organization (or the first), find the first item
 * with an identifierref, resolve it to a <resource href>. If no item references a
 * resource, fall back to the first resource that has an href. Throws ManifestError
 * when the XML is unparseable or no launchable resource exists.
 */
export function parseManifest(xml: string): ParsedManifest {
  let doc: Record<string, unknown>;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
    });
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new ManifestError("Could not parse imsmanifest.xml.");
  }

  const manifest = doc["manifest"] as Record<string, unknown> | undefined;
  if (!manifest) throw new ManifestError("imsmanifest.xml has no <manifest> root.");

  const resources = toArray(
    (manifest["resources"] as Record<string, unknown> | undefined)?.["resource"] as
      | Record<string, unknown>
      | Record<string, unknown>[]
      | undefined
  );

  // Try to resolve via the default organization's first referenced resource.
  const orgs = manifest["organizations"] as Record<string, unknown> | undefined;
  const orgList = toArray(orgs?.["organization"] as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const defaultId = orgs?.["@_default"];
  const org =
    orgList.find((o) => o["@_identifier"] === defaultId) ?? orgList[0];

  if (org) {
    for (const item of toArray(org["item"] as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
      const ref = firstItemRef(item);
      if (ref) {
        const res = resources.find((r) => r["@_identifier"] === ref);
        const href = res?.["@_href"];
        if (typeof href === "string" && href) {
          return { entryHref: href, version: schemaVersion(manifest) };
        }
      }
    }
  }

  // Fallback: first resource with an href (prefer a SCO).
  const sco = resources.find((r) => r["@_scormtype"] === "sco" && typeof r["@_href"] === "string");
  const any = sco ?? resources.find((r) => typeof r["@_href"] === "string");
  const href = any?.["@_href"];
  if (typeof href === "string" && href) {
    return { entryHref: href, version: schemaVersion(manifest) };
  }

  throw new ManifestError("imsmanifest.xml has no launchable resource (no <resource href>).");
}

function schemaVersion(manifest: Record<string, unknown>): string {
  const md = manifest["metadata"] as Record<string, unknown> | undefined;
  const v = md?.["schemaversion"];
  return typeof v === "string" && v.trim() ? v.trim() : "1.2";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/learning/engine/manifest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/learning/engine/manifest.ts src/modules/learning/engine/manifest.test.ts
git commit -m "feat(learning): SCORM manifest parser"
```

---

## Task 3: Status derivation engine (pure, TDD)

**Files:**
- Create: `src/modules/learning/engine/status.ts`
- Test: `src/modules/learning/engine/status.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/learning/engine/status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveStatus, parseScore } from "./status";

describe("deriveStatus", () => {
  it("treats passed and completed as COMPLETE", () => {
    expect(deriveStatus("completed")).toEqual({ status: "COMPLETE", completed: true });
    expect(deriveStatus("passed")).toEqual({ status: "COMPLETE", completed: true });
    expect(deriveStatus("PASSED")).toEqual({ status: "COMPLETE", completed: true });
  });

  it("treats failed/incomplete/browsed as IN_PROGRESS", () => {
    for (const s of ["failed", "incomplete", "browsed"]) {
      expect(deriveStatus(s)).toEqual({ status: "IN_PROGRESS", completed: false });
    }
  });

  it("treats missing/blank/not attempted as IN_PROGRESS (caller decides not-started)", () => {
    expect(deriveStatus(null).completed).toBe(false);
    expect(deriveStatus("").completed).toBe(false);
    expect(deriveStatus("not attempted").completed).toBe(false);
  });
});

describe("parseScore", () => {
  it("parses a numeric string to a rounded int", () => {
    expect(parseScore("85")).toBe(85);
    expect(parseScore("90.4")).toBe(90);
  });
  it("returns null for missing or blank", () => {
    expect(parseScore(null)).toBeNull();
    expect(parseScore("")).toBeNull();
    expect(parseScore("  ")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/learning/engine/status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/modules/learning/engine/status.ts`:

```ts
export type DerivedStatus = {
  status: "IN_PROGRESS" | "COMPLETE";
  completed: boolean;
};

const COMPLETE = new Set(["passed", "completed"]);

/** Map a raw SCORM 1.2 cmi.core.lesson_status to the hub's coarse status. */
export function deriveStatus(lessonStatus: string | null | undefined): DerivedStatus {
  const norm = (lessonStatus ?? "").trim().toLowerCase();
  const completed = COMPLETE.has(norm);
  return { status: completed ? "COMPLETE" : "IN_PROGRESS", completed };
}

/** Parse cmi.core.score.raw (a string) to a rounded int, or null when absent. */
export function parseScore(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n) : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/learning/engine/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/learning/engine/status.ts src/modules/learning/engine/status.test.ts
git commit -m "feat(learning): SCORM status derivation"
```

---

## Task 4: Storage `deletePrefix` helper

**Files:**
- Modify: `src/platform/storage.ts`

- [ ] **Step 1: Add `deletePrefix` to storage.ts**

Append this function to `src/platform/storage.ts` (after `deleteObject`):

```ts
/**
 * Delete every object stored under `prefix` (e.g. "scorm/<courseId>/"). Used when
 * replacing a SCORM package so stale files from the previous upload don't linger.
 */
export async function deletePrefix(prefix: string): Promise<void> {
  if (blobToken) {
    const { list, del } = await import("@vercel/blob");
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, token: blobToken });
      if (page.blobs.length > 0) {
        await del(page.blobs.map((b) => b.url), { token: blobToken });
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return;
  }
  // Local disk: prefix maps to a directory under UPLOAD_DIR.
  const dir = localPath(prefix.replace(/\/$/, ""));
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit 2>&1 | grep storage.ts || echo "storage.ts clean"`
Expected: `storage.ts clean`.

- [ ] **Step 3: Commit**

```bash
git add src/platform/storage.ts
git commit -m "feat(storage): add deletePrefix for replacing object trees"
```

---

## Task 5: SCORM zip test fixture builder

**Files:**
- Create: `src/modules/learning/services/test-fixtures.ts`

- [ ] **Step 1: Create the fixture builder**

Create `src/modules/learning/services/test-fixtures.ts` (no test of its own — exercised by Task 6):

```ts
import { zipSync, strToU8 } from "fflate";

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MAN-1" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>Course</title>
      <item identifier="ITEM-1" identifierref="RES-1"><title>Lesson</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/>
      <file href="assets/app.js"/>
    </resource>
  </resources>
</manifest>`;

/** A minimal, valid SCORM 1.2 package: manifest + index.html + one asset. */
export function makeScormZip(): Buffer {
  const files: Record<string, Uint8Array> = {
    "imsmanifest.xml": strToU8(MANIFEST),
    "index.html": strToU8("<!doctype html><title>Lesson</title><script src='assets/app.js'></script>"),
    "assets/app.js": strToU8("console.log('scorm');"),
  };
  return Buffer.from(zipSync(files));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/modules/learning/services/test-fixtures.ts
git commit -m "test(learning): in-memory SCORM zip fixture builder"
```

---

## Task 6: Package ingest service (TDD)

**Files:**
- Create: `src/modules/learning/services/packages.ts`
- Test: `src/modules/learning/services/packages.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/learning/services/packages.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getObject } from "@/platform/storage";
import { LearningAuthError, LearningValidationError } from "./errors";
import { ingestScormPackage } from "./packages";
import { makeScormZip } from "./test-fixtures";

async function seed() {
  const manager = await prisma.person.create({ data: { name: "Mgr", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: { name: "Learning Admin", grants: { create: [{ permission: "learning.manage_courses" }] } },
  });
  await prisma.roleAssignment.create({ data: { personId: manager.id, roleId: role.id } });
  const plain = await prisma.person.create({ data: { name: "Plain", status: "ACTIVE" } });
  const course = await prisma.course.create({ data: { title: "Intro" } });
  return { manager, plain, course };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("rejects ingest without the manage permission", async () => {
  const { plain, course } = await seed();
  await expect(ingestScormPackage(course.id, makeScormZip(), plain.id)).rejects.toBeInstanceOf(LearningAuthError);
});

it("stores package files and sets the course entry href + version", async () => {
  const { manager, course } = await seed();
  await ingestScormPackage(course.id, makeScormZip(), manager.id);

  const updated = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
  expect(updated.scormEntryHref).toBe("index.html");
  expect(updated.scormVersion).toBe("1.2");
  expect(updated.scormUploadedAt).not.toBeNull();

  expect(await getObject(`scorm/${course.id}/index.html`)).not.toBeNull();
  expect(await getObject(`scorm/${course.id}/assets/app.js`)).not.toBeNull();
});

it("rejects a zip with no imsmanifest.xml", async () => {
  const { manager, course } = await seed();
  const { zipSync, strToU8 } = await import("fflate");
  const bad = Buffer.from(zipSync({ "index.html": strToU8("<html></html>") }));
  await expect(ingestScormPackage(course.id, bad, manager.id)).rejects.toBeInstanceOf(LearningValidationError);
});

it("replacing a package removes files that are no longer present", async () => {
  const { manager, course } = await seed();
  await ingestScormPackage(course.id, makeScormZip(), manager.id);
  expect(await getObject(`scorm/${course.id}/assets/app.js`)).not.toBeNull();

  // A second package without assets/app.js
  const { zipSync, strToU8 } = await import("fflate");
  const manifest = (await getObject(`scorm/${course.id}/index.html`)) ? null : null; // noop guard
  void manifest;
  const slim = Buffer.from(
    zipSync({
      "imsmanifest.xml": strToU8(
        `<manifest xmlns="x" xmlns:adlcp="y"><organizations default="O"><organization identifier="O"><item identifier="I" identifierref="R"/></organization></organizations><resources><resource identifier="R" adlcp:scormtype="sco" href="index.html"/></resources></manifest>`
      ),
      "index.html": strToU8("<html>v2</html>"),
    })
  );
  await ingestScormPackage(course.id, slim, manager.id);
  expect(await getObject(`scorm/${course.id}/index.html`)).not.toBeNull();
  expect(await getObject(`scorm/${course.id}/assets/app.js`)).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/learning/services/packages.test.ts`
Expected: FAIL — `ingestScormPackage` not found.

- [ ] **Step 3: Implement the ingest service**

Create `src/modules/learning/services/packages.ts`:

```ts
import { unzipSync } from "fflate";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { putObject, deletePrefix } from "@/platform/storage";
import { parseManifest, ManifestError } from "../engine/manifest";
import { LearningAuthError, LearningValidationError } from "./errors";

const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB unzipped

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
};

export function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** Reject path-traversal and absolute paths in zip entry names. */
function safeRelPath(name: string): string {
  const norm = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (norm.split("/").some((seg) => seg === "..")) {
    throw new LearningValidationError(`Unsafe path in package: ${name}`);
  }
  return norm;
}

async function requireManager(actorId: string): Promise<void> {
  if (!(await can(actorId, "learning.manage_courses"))) {
    throw new LearningAuthError("You do not have permission to manage courses.");
  }
}

/**
 * Unzip a SCORM 1.2 package, validate its manifest, store every file under
 * scorm/<courseId>/, and record the launch href + version on the course.
 * Replacing: the existing scorm/<courseId>/ tree is deleted first.
 */
export async function ingestScormPackage(courseId: string, zipBytes: Buffer, actorId: string): Promise<void> {
  await requireManager(actorId);
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) throw new LearningValidationError("Course not found.");

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(zipBytes));
  } catch {
    throw new LearningValidationError("Could not read the uploaded file as a .zip.");
  }

  // Drop directory entries (zero-length, trailing slash).
  const files = Object.entries(entries).filter(([name]) => !name.endsWith("/"));
  if (files.length === 0) throw new LearningValidationError("The package is empty.");
  if (files.length > MAX_FILES) throw new LearningValidationError("The package has too many files.");
  const totalBytes = files.reduce((sum, [, bytes]) => sum + bytes.byteLength, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new LearningValidationError("The package is too large.");

  // Find the manifest (SCORM requires it at the package root).
  const manifestEntry = files.find(([name]) => name.toLowerCase() === "imsmanifest.xml");
  if (!manifestEntry) throw new LearningValidationError("The package has no imsmanifest.xml at its root.");

  let parsed;
  try {
    parsed = parseManifest(Buffer.from(manifestEntry[1]).toString("utf8"));
  } catch (err) {
    if (err instanceof ManifestError) throw new LearningValidationError(err.message);
    throw err;
  }

  // Replace: clear any previous package for this course first.
  await deletePrefix(`scorm/${courseId}/`);

  for (const [name, bytes] of files) {
    const rel = safeRelPath(name);
    await putObject(`scorm/${courseId}/${rel}`, Buffer.from(bytes), contentTypeFor(rel));
  }

  await prisma.course.update({
    where: { id: courseId },
    data: { scormEntryHref: parsed.entryHref, scormVersion: parsed.version, scormUploadedAt: new Date() },
  });

  await recordAudit({
    actorPersonId: actorId,
    action: "learning.package_upload",
    entityType: "Course",
    entityId: courseId,
    after: { entryHref: parsed.entryHref, version: parsed.version, fileCount: files.length },
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/learning/services/packages.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/learning/services/packages.ts src/modules/learning/services/packages.test.ts
git commit -m "feat(learning): SCORM package ingest service"
```

---

## Task 7: Rewrite the courses service (drop module CRUD)

**Files:**
- Modify: `src/modules/learning/services/courses.ts`
- Modify: `src/modules/learning/services/courses.test.ts`

- [ ] **Step 1: Replace courses.ts**

Replace the entire contents of `src/modules/learning/services/courses.ts` with (module CRUD, `ModuleInput`, `validateModule`, `build*`, `reorderModules`, `parseQuizQuestions` import all removed):

```ts
import type { Course } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { LearningAuthError, LearningValidationError } from "./errors";

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
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.course_create",
    entityType: "Course",
    entityId: course.id,
    after: { title },
  });
  return course;
}

export async function updateCourse(id: string, input: CourseInput, actorId: string): Promise<Course> {
  await requireManager(actorId);
  const title = input.title.trim();
  if (!title) throw new LearningValidationError("Course title is required.");
  const existing = await prisma.course.findUnique({ where: { id } });
  if (!existing) throw new LearningValidationError("Course not found.");
  const course = await prisma.course.update({
    where: { id },
    data: {
      title,
      description: input.description?.trim() || null,
      isActive: input.isActive ?? undefined,
    },
  });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.course_update",
    entityType: "Course",
    entityId: id,
    after: { title, isActive: course.isActive },
  });
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
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.course_assign",
    entityType: "Course",
    entityId: courseId,
    after: input as unknown as Prisma.InputJsonValue,
  });
}

export type CourseListRow = {
  id: string;
  title: string;
  isActive: boolean;
  assignToAll: boolean;
  hasPackage: boolean;
};

export async function listCourses(): Promise<CourseListRow[]> {
  const courses = await prisma.course.findMany({ orderBy: { position: "asc" } });
  return courses.map((c) => ({
    id: c.id,
    title: c.title,
    isActive: c.isActive,
    assignToAll: c.assignToAll,
    hasPackage: c.scormEntryHref != null,
  }));
}

export async function getCourseForEdit(id: string) {
  return prisma.course.findUnique({ where: { id }, include: { departments: true } });
}
```

- [ ] **Step 2: Replace courses.test.ts**

Replace the entire contents of `src/modules/learning/services/courses.test.ts` with (all module/quiz tests removed):

```ts
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
  await setCourseAssignment(course.id, { departmentIds: [dept.id], assignToAll: false }, manager.id);
  const edited = await getCourseForEdit(course.id);
  expect(edited!.departments.map((d) => d.departmentId)).toEqual([dept.id]);
});
```

- [ ] **Step 3: Run to verify it passes**

Run: `npx vitest run src/modules/learning/services/courses.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 4: Commit**

```bash
git add src/modules/learning/services/courses.ts src/modules/learning/services/courses.test.ts
git commit -m "feat(learning): trim courses service to SCORM-shaped course CRUD"
```

---

## Task 8: Rewrite the enrollment service (`persistCmi`, SCORM reads) (TDD)

**Files:**
- Modify: `src/modules/learning/services/enrollment.ts`
- Modify: `src/modules/learning/services/enrollment.test.ts`

- [ ] **Step 1: Replace enrollment.ts**

Replace the entire contents of `src/modules/learning/services/enrollment.ts` with:

```ts
import { prisma } from "@/platform/db";
import { coursesForMember, type AssignableCourse } from "../engine/assignment";
import { deriveStatus } from "../engine/status";
import { LearningAuthError } from "./errors";

/** Active term used for assignment (newest ACTIVE term). */
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

/** True when the course is currently assigned to this person (for the play route). */
export async function isCourseAssignedTo(personId: string, courseId: string): Promise<boolean> {
  const ids = await assignedCourseIds(personId);
  return ids.includes(courseId);
}

export type LearnerStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE";

export type MyCourseRow = {
  id: string;
  title: string;
  description: string | null;
  status: LearnerStatus;
};

export async function getMyCourses(personId: string): Promise<MyCourseRow[]> {
  const ids = await assignedCourseIds(personId);
  if (ids.length === 0) return [];
  const courses = await prisma.course.findMany({
    where: { id: { in: ids } },
    orderBy: { position: "asc" },
    select: { id: true, title: true, description: true },
  });
  const progress = await prisma.courseProgress.findMany({
    where: { personId, courseId: { in: ids } },
    select: { courseId: true, lessonStatus: true },
  });
  const byCourse = new Map(progress.map((p) => [p.courseId, p]));
  return courses.map((c) => {
    const p = byCourse.get(c.id);
    const status: LearnerStatus = !p
      ? "NOT_STARTED"
      : deriveStatus(p.lessonStatus).status;
    return { id: c.id, title: c.title, description: c.description, status };
  });
}

export type LearnerCourse = {
  id: string;
  title: string;
  description: string | null;
  entryHref: string | null;
  status: LearnerStatus;
  cmi: {
    lessonStatus: string | null;
    scoreRaw: number | null;
    suspendData: string | null;
    lessonLocation: string | null;
  };
};

export async function getCourseForLearner(personId: string, courseId: string): Promise<LearnerCourse> {
  if (!(await isCourseAssignedTo(personId, courseId))) {
    throw new LearningAuthError("This course is not assigned to you.");
  }
  const course = await prisma.course.findUniqueOrThrow({ where: { id: courseId } });
  const progress = await prisma.courseProgress.findUnique({
    where: { personId_courseId: { personId, courseId } },
  });
  const status: LearnerStatus = !progress ? "NOT_STARTED" : deriveStatus(progress.lessonStatus).status;
  return {
    id: course.id,
    title: course.title,
    description: course.description,
    entryHref: course.scormEntryHref,
    status,
    cmi: {
      lessonStatus: progress?.lessonStatus ?? null,
      scoreRaw: progress?.scoreRaw ?? null,
      suspendData: progress?.suspendData ?? null,
      lessonLocation: progress?.lessonLocation ?? null,
    },
  };
}

export type CmiSnapshot = {
  lessonStatus: string | null;
  scoreRaw: number | null;
  suspendData: string | null;
  lessonLocation: string | null;
};

/**
 * Persist a SCORM CMI snapshot for one person+course. Idempotent: re-commits
 * update the state; completedAt is stamped once (the first time status becomes
 * COMPLETE) and preserved on later commits.
 */
export async function persistCmi(personId: string, courseId: string, cmi: CmiSnapshot): Promise<void> {
  if (!(await isCourseAssignedTo(personId, courseId))) {
    throw new LearningAuthError("This course is not assigned to you.");
  }
  const { status, completed } = deriveStatus(cmi.lessonStatus);
  const existing = await prisma.courseProgress.findUnique({
    where: { personId_courseId: { personId, courseId } },
    select: { completedAt: true },
  });
  const completedAt = completed ? (existing?.completedAt ?? new Date()) : null;

  const data = {
    status,
    completedAt,
    lessonStatus: cmi.lessonStatus,
    scoreRaw: cmi.scoreRaw,
    suspendData: cmi.suspendData,
    lessonLocation: cmi.lessonLocation,
  };
  await prisma.courseProgress.upsert({
    where: { personId_courseId: { personId, courseId } },
    create: { personId, courseId, ...data },
    update: data,
  });
}
```

- [ ] **Step 2: Replace enrollment.test.ts**

Replace the entire contents of `src/modules/learning/services/enrollment.test.ts` with:

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { LearningAuthError } from "./errors";
import { getMyCourses, getCourseForLearner, persistCmi, isCourseAssignedTo } from "./enrollment";

/** A learner assigned to one active, department-scoped course with a package. */
async function seed() {
  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const other = await prisma.department.create({ data: { code: "MED", name: "Medical" } });
  const learner = await prisma.person.create({ data: { name: "Lee", status: "ACTIVE" } });
  const term = await prisma.term.create({
    data: { code: "SU26", name: "T1", status: "ACTIVE", startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31") },
  });
  await prisma.termMembership.create({
    data: { personId: learner.id, termId: term.id, departmentId: dept.id, status: "ACTIVE", kind: "VOLUNTEER" },
  });
  const course = await prisma.course.create({
    data: {
      title: "Intro",
      description: "d",
      scormEntryHref: "index.html",
      scormVersion: "1.2",
      departments: { create: [{ departmentId: dept.id }] },
    },
  });
  const unassigned = await prisma.course.create({
    data: { title: "Other", scormEntryHref: "index.html", departments: { create: [{ departmentId: other.id }] } },
  });
  return { learner, dept, course, unassigned };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("lists assigned courses as NOT_STARTED before any progress", async () => {
  const { learner, course } = await seed();
  const rows = await getMyCourses(learner.id);
  expect(rows.map((r) => r.id)).toEqual([course.id]);
  expect(rows[0].status).toBe("NOT_STARTED");
});

it("isCourseAssignedTo reflects department assignment", async () => {
  const { learner, course, unassigned } = await seed();
  expect(await isCourseAssignedTo(learner.id, course.id)).toBe(true);
  expect(await isCourseAssignedTo(learner.id, unassigned.id)).toBe(false);
});

it("getCourseForLearner refuses an unassigned course", async () => {
  const { learner, unassigned } = await seed();
  await expect(getCourseForLearner(learner.id, unassigned.id)).rejects.toBeInstanceOf(LearningAuthError);
});

it("persistCmi records status and stamps completedAt once on completion", async () => {
  const { learner, course } = await seed();
  await persistCmi(learner.id, course.id, {
    lessonStatus: "incomplete", scoreRaw: null, suspendData: "page=1", lessonLocation: "1",
  });
  let row = await getCourseForLearner(learner.id, course.id);
  expect(row.status).toBe("IN_PROGRESS");
  expect(row.cmi.suspendData).toBe("page=1");

  await persistCmi(learner.id, course.id, {
    lessonStatus: "passed", scoreRaw: 90, suspendData: "page=9", lessonLocation: "9",
  });
  row = await getCourseForLearner(learner.id, course.id);
  expect(row.status).toBe("COMPLETE");
  expect(row.cmi.scoreRaw).toBe(90);

  const first = await prisma.courseProgress.findFirstOrThrow({ where: { personId: learner.id, courseId: course.id } });
  const firstCompletedAt = first.completedAt;

  // A later commit that stays complete must not move completedAt.
  await persistCmi(learner.id, course.id, {
    lessonStatus: "completed", scoreRaw: 95, suspendData: "page=9", lessonLocation: "9",
  });
  const again = await prisma.courseProgress.findFirstOrThrow({ where: { personId: learner.id, courseId: course.id } });
  expect(again.completedAt?.getTime()).toBe(firstCompletedAt?.getTime());
});

it("persistCmi refuses an unassigned course", async () => {
  const { learner, unassigned } = await seed();
  await expect(
    persistCmi(learner.id, unassigned.id, { lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null })
  ).rejects.toBeInstanceOf(LearningAuthError);
});
```

> Note: if `termMembership` requires fields beyond those shown (e.g. a different enum for `kind`), mirror exactly what `dashboard.test.ts`/other existing tests use — check `prisma/schema.prisma` for the `TermMembership` model and adjust the `create` data accordingly before running.

- [ ] **Step 3: Run to verify it passes**

Run: `npx vitest run src/modules/learning/services/enrollment.test.ts`
Expected: PASS (5 tests). If a `TermMembership` field mismatch fails seeding, fix per the note and re-run.

- [ ] **Step 4: Commit**

```bash
git add src/modules/learning/services/enrollment.ts src/modules/learning/services/enrollment.test.ts
git commit -m "feat(learning): SCORM enrollment service (persistCmi + learner reads)"
```

---

## Task 9: Rewrite the dashboard service (TDD)

**Files:**
- Modify: `src/modules/learning/services/dashboard.ts`
- Modify: `src/modules/learning/services/dashboard.test.ts`

- [ ] **Step 1: Replace dashboard.ts**

Replace the entire contents of `src/modules/learning/services/dashboard.ts` with:

```ts
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { recordAudit } from "@/platform/audit";
import { deriveStatus } from "../engine/status";
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
  scoreRaw: number | null;
};

/** For one course: every active member of an assigned department in the active
 *  term, with their SCORM completion status + score. assignToAll covers all depts. */
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
    where: { termId: term.id, status: "ACTIVE", ...deptFilter },
    include: { person: { select: { id: true, name: true } }, department: { select: { code: true } } },
  });

  const personIds = memberships.map((m) => m.person.id);
  const progressRows = await prisma.courseProgress.findMany({
    where: { courseId, personId: { in: personIds } },
    select: { personId: true, lessonStatus: true, scoreRaw: true, completedAt: true },
  });
  const byPerson = new Map(progressRows.map((p) => [p.personId, p]));

  // De-duplicate by personId so multi-dept memberships don't double-list a learner.
  const seen = new Set<string>();
  const unique = memberships.filter((m) => {
    if (seen.has(m.person.id)) return false;
    seen.add(m.person.id);
    return true;
  });

  return unique
    .map<CompletionRow>((m) => {
      const p = byPerson.get(m.person.id);
      const status: CompletionRow["status"] = !p
        ? "NOT_STARTED"
        : deriveStatus(p.lessonStatus).status;
      return {
        personId: m.person.id,
        name: m.person.name,
        departmentCode: m.department.code,
        status,
        completedAt: status === "COMPLETE" ? (p?.completedAt ?? null) : null,
        scoreRaw: p?.scoreRaw ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Clear a learner's progress on a course so they can retake it. */
export async function resetCourseProgress(personId: string, courseId: string, actorId: string): Promise<void> {
  if (!(await can(actorId, "learning.manage_courses"))) {
    throw new LearningAuthError("You do not have permission to reset progress.");
  }
  await prisma.courseProgress.deleteMany({ where: { personId, courseId } });
  await recordAudit({
    actorPersonId: actorId,
    action: "learning.progress_reset",
    entityType: "Course",
    entityId: courseId,
    after: { personId },
  });
}

/** Active courses for the dashboard's course picker. */
export async function listCoursesForDashboard(viewerId: string): Promise<{ id: string; title: string }[]> {
  await requireViewer(viewerId);
  return prisma.course.findMany({ where: { isActive: true }, orderBy: { position: "asc" }, select: { id: true, title: true } });
}
```

- [ ] **Step 2: Replace dashboard.test.ts**

Replace the entire contents of `src/modules/learning/services/dashboard.test.ts` with:

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetDb } from "@/platform/test/db";
import { prisma } from "@/platform/db";
import { getCourseCompletion, resetCourseProgress } from "./dashboard";

async function seed() {
  const viewer = await prisma.person.create({ data: { name: "Viewer", status: "ACTIVE" } });
  const role = await prisma.role.create({
    data: {
      name: "Learning Viewer",
      grants: { create: [{ permission: "learning.view_progress" }, { permission: "learning.manage_courses" }] },
    },
  });
  await prisma.roleAssignment.create({ data: { personId: viewer.id, roleId: role.id } });

  const dept = await prisma.department.create({ data: { code: "SRHD", name: "SRHD" } });
  const learner = await prisma.person.create({ data: { name: "Lee", status: "ACTIVE" } });
  const term = await prisma.term.create({
    data: { code: "SU26", name: "T1", status: "ACTIVE", startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31") },
  });
  await prisma.termMembership.create({
    data: { personId: learner.id, termId: term.id, departmentId: dept.id, status: "ACTIVE", kind: "VOLUNTEER" },
  });
  const course = await prisma.course.create({
    data: { title: "Intro", scormEntryHref: "index.html", departments: { create: [{ departmentId: dept.id }] } },
  });
  return { viewer, learner, dept, course };
}

beforeEach(async () => { await resetDb(); });
afterEach(async () => { await resetDb(); });

it("lists assigned members as NOT_STARTED with no progress", async () => {
  const { viewer, learner, course } = await seed();
  const rows = await getCourseCompletion(course.id, viewer.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ personId: learner.id, status: "NOT_STARTED", scoreRaw: null });
});

it("derives COMPLETE + score from a passed CourseProgress", async () => {
  const { viewer, learner, course } = await seed();
  await prisma.courseProgress.create({
    data: { personId: learner.id, courseId: course.id, status: "COMPLETE", lessonStatus: "passed", scoreRaw: 88, completedAt: new Date() },
  });
  const rows = await getCourseCompletion(course.id, viewer.id);
  expect(rows[0]).toMatchObject({ status: "COMPLETE", scoreRaw: 88 });
  expect(rows[0].completedAt).not.toBeNull();
});

it("resetCourseProgress clears a learner's row", async () => {
  const { viewer, learner, course } = await seed();
  await prisma.courseProgress.create({
    data: { personId: learner.id, courseId: course.id, status: "COMPLETE", lessonStatus: "passed", completedAt: new Date() },
  });
  await resetCourseProgress(learner.id, course.id, viewer.id);
  const rows = await getCourseCompletion(course.id, viewer.id);
  expect(rows[0].status).toBe("NOT_STARTED");
});
```

- [ ] **Step 3: Run to verify it passes**

Run: `npx vitest run src/modules/learning/services/dashboard.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add src/modules/learning/services/dashboard.ts src/modules/learning/services/dashboard.test.ts
git commit -m "feat(learning): SCORM-derived completion dashboard service"
```

---

## Task 10: Delete dead engine + types files

**Files:**
- Delete: `src/modules/learning/engine/completion.ts`
- Delete: `src/modules/learning/engine/completion.test.ts`
- Delete: `src/modules/learning/services/types.ts`

- [ ] **Step 1: Delete the files**

Run:
```bash
git rm src/modules/learning/engine/completion.ts src/modules/learning/engine/completion.test.ts src/modules/learning/services/types.ts
```

- [ ] **Step 2: Verify nothing still imports them**

Run: `grep -rn "engine/completion\|services/types\|parseQuizQuestions\|isCourseComplete\|progressCounts" src/ || echo "no references"`
Expected: `no references`.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore(learning): remove native completion engine + quiz types"
```

---

## Task 11: SCORM file-serving route handler

**Files:**
- Create: `src/app/learning/play/[courseId]/[...path]/route.ts`

- [ ] **Step 1: Implement the route handler**

Create `src/app/learning/play/[courseId]/[...path]/route.ts` (mirrors the auth/404 pattern of `src/app/my-info/certificate/[id]/route.ts`):

```ts
import { auth } from "@/platform/auth/auth";
import { getActivePerson } from "@/platform/auth/match-person";
import { getObject } from "@/platform/storage";
import { can } from "@/platform/rbac/engine";
import { isCourseAssignedTo } from "@/modules/learning/services/enrollment";
import { contentTypeFor } from "@/modules/learning/services/packages";

type RouteContext = { params: Promise<{ courseId: string; path: string[] }> };

/**
 * GET /learning/play/[courseId]/[...path]
 *
 * Streams one file of a course's SCORM package, same-origin, so the SCORM API on
 * the player page is reachable from the iframe. Access: the signed-in person must
 * be assigned the course, or hold learning.manage_courses (admin preview). 404 is
 * returned for missing files and unauthorized access alike (no enumeration).
 */
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const session = await auth();
  if (!session?.personId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const person = await getActivePerson(session.personId);
  if (!person) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { courseId, path } = await context.params;

  const allowed =
    (await isCourseAssignedTo(person.id, courseId)) || (await can(person.id, "learning.manage_courses"));
  if (!allowed) return Response.json({ error: "Not found" }, { status: 404 });

  // Build the relative path; refuse traversal.
  const rel = path.join("/");
  if (rel.split("/").some((seg) => seg === "..")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const buf = await getObject(`scorm/${courseId}/${rel}`);
  if (!buf) return Response.json({ error: "Not found" }, { status: 404 });

  const bytes = new Uint8Array(buf);
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentTypeFor(rel),
      "Content-Length": String(buf.byteLength),
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit 2>&1 | grep "learning/play" || echo "route clean"`
Expected: `route clean`.

- [ ] **Step 3: Commit**

```bash
git add src/app/learning/play
git commit -m "feat(learning): same-origin SCORM package file route"
```

---

## Task 12: Server actions (upload, persist-cmi, reset)

**Files:**
- Modify: `src/app/learning/manage/actions.ts`
- Modify: `src/app/learning/actions.ts`
- Modify: `src/app/learning/dashboard/actions.ts`

- [ ] **Step 1: Replace manage/actions.ts**

Replace the entire contents of `src/app/learning/manage/actions.ts` with (`addModuleAction` → `uploadPackageAction`):

```ts
"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { createCourse, updateCourse, setCourseAssignment } from "@/modules/learning/services/courses";
import { ingestScormPackage } from "@/modules/learning/services/packages";
import { LearningValidationError } from "@/modules/learning/services/errors";

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

export async function uploadPackageAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  const courseId = String(formData.get("courseId"));
  const file = formData.get("package");
  if (!(file instanceof File) || file.size === 0) {
    throw new LearningValidationError("Choose a .zip SCORM package to upload.");
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  await ingestScormPackage(courseId, bytes, person.personId);
  revalidatePath(`/learning/manage/${courseId}`);
}
```

- [ ] **Step 2: Replace actions.ts (learner)**

Replace the entire contents of `src/app/learning/actions.ts` with (a single server action callable from the client player):

```ts
"use server";
import { requirePermission } from "@/platform/auth/session";
import { persistCmi, type CmiSnapshot } from "@/modules/learning/services/enrollment";

export async function persistCmiAction(courseId: string, cmi: CmiSnapshot): Promise<void> {
  const person = await requirePermission("learning.access");
  await persistCmi(person.personId, courseId, cmi);
}
```

- [ ] **Step 3: Replace dashboard/actions.ts**

Replace the entire contents of `src/app/learning/dashboard/actions.ts` with:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/platform/auth/session";
import { resetCourseProgress } from "@/modules/learning/services/dashboard";

export async function resetCourseProgressAction(formData: FormData): Promise<void> {
  const person = await requirePermission("learning.manage_courses");
  await resetCourseProgress(String(formData.get("personId")), String(formData.get("courseId")), person.personId);
  revalidatePath("/learning/dashboard");
}
```

- [ ] **Step 4: Verify compile**

Run: `npx tsc --noEmit 2>&1 | grep "learning/.*actions" || echo "actions clean"`
Expected: `actions clean`.

- [ ] **Step 5: Commit**

```bash
git add src/app/learning/manage/actions.ts src/app/learning/actions.ts src/app/learning/dashboard/actions.ts
git commit -m "feat(learning): server actions for package upload, CMI persist, progress reset"
```

---

## Task 13: Player page + ScormPlayer client component

**Files:**
- Create: `src/app/learning/[courseId]/ScormPlayer.tsx`
- Modify: `src/app/learning/[courseId]/page.tsx`

- [ ] **Step 1: Create the ScormPlayer client component**

Create `src/app/learning/[courseId]/ScormPlayer.tsx`:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { Scorm12API } from "scorm-again/scorm12";
import { persistCmiAction } from "../actions";
import type { CmiSnapshot } from "@/modules/learning/services/enrollment";

type Props = {
  courseId: string;
  entryHref: string;
  initialCmi: CmiSnapshot;
};

/**
 * Hosts a SCORM 1.2 runtime as window.API and renders the package in an iframe.
 * The package (served same-origin from /learning/play/...) walks up to window.parent
 * to find API. On every commit/finish we read the CMI and persist it server-side.
 */
export function ScormPlayer({ courseId, entryHref, initialCmi }: Props) {
  const [ready, setReady] = useState(false);
  const apiRef = useRef<Scorm12API | null>(null);

  useEffect(() => {
    const api = new Scorm12API({ autocommit: true, autocommitSeconds: 30, logLevel: 4 });

    // Seed saved progress so the package can resume.
    if (initialCmi.lessonStatus) api.cmi.core.lesson_status = initialCmi.lessonStatus;
    if (initialCmi.lessonLocation) api.cmi.core.lesson_location = initialCmi.lessonLocation;
    if (initialCmi.scoreRaw != null) api.cmi.core.score.raw = String(initialCmi.scoreRaw);
    if (initialCmi.suspendData) api.cmi.suspend_data = initialCmi.suspendData;

    const snapshot = (): CmiSnapshot => ({
      lessonStatus: api.cmi.core.lesson_status || null,
      scoreRaw: api.cmi.core.score.raw === "" ? null : Number(api.cmi.core.score.raw),
      suspendData: api.cmi.suspend_data || null,
      lessonLocation: api.cmi.core.lesson_location || null,
    });
    const save = () => { void persistCmiAction(courseId, snapshot()); };
    api.on("LMSCommit", save);
    api.on("LMSFinish", save);

    (window as unknown as { API: Scorm12API }).API = api;
    apiRef.current = api;
    setReady(true);

    return () => {
      // Best-effort final save and teardown.
      save();
      delete (window as unknown as { API?: Scorm12API }).API;
      apiRef.current = null;
    };
    // initialCmi/courseId are stable for the life of this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <iframe
      title="Course content"
      src={`/learning/play/${courseId}/${entryHref}`}
      className="h-[80vh] w-full rounded border border-slate-200"
    />
  );
}
```

> Note on the import: `scorm-again` ships subpath entrypoints; `scorm-again/scorm12` exposes `Scorm12API`. If TypeScript cannot resolve the subpath, import from the package root instead (`import { Scorm12API } from "scorm-again";`) — verify which resolves with `npx tsc --noEmit` and keep the one that compiles.

- [ ] **Step 2: Replace the player page**

Replace the entire contents of `src/app/learning/[courseId]/page.tsx` with:

```tsx
import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { getCourseForLearner } from "@/modules/learning/services/enrollment";
import { LearningAuthError } from "@/modules/learning/services/errors";
import { ScormPlayer } from "./ScormPlayer";

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
    <>
      <PageHeader title={course.title} description={course.description ?? undefined} />
      <div className="mt-6 space-y-4">
        {course.status === "COMPLETE" && (
          <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">
            You have completed this course.
          </p>
        )}
        {course.entryHref ? (
          <ScormPlayer courseId={course.id} entryHref={course.entryHref} initialCmi={course.cmi} />
        ) : (
          <p className="text-sm text-slate-500">This course has no content uploaded yet. Check back soon.</p>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 3: Verify compile**

Run: `npx tsc --noEmit 2>&1 | grep "learning/\[courseId\]" || echo "player clean"`
Expected: `player clean` (resolve the `scorm-again` import per the Step 1 note if needed).

- [ ] **Step 4: Commit**

```bash
git add src/app/learning/[courseId]/page.tsx src/app/learning/[courseId]/ScormPlayer.tsx
git commit -m "feat(learning): SCORM player page with scorm-again runtime"
```

---

## Task 14: Manage UI (course list + edit/upload)

**Files:**
- Modify: `src/app/learning/manage/page.tsx`
- Modify: `src/app/learning/manage/[courseId]/page.tsx`

- [ ] **Step 1: Replace the manage list page**

Replace the entire contents of `src/app/learning/manage/page.tsx` with (badge now reflects package presence):

```tsx
import Link from "next/link";
import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { listCourses } from "@/modules/learning/services/courses";
import { createCourseAction } from "./actions";

export default async function ManageCoursesPage() {
  await requirePermission("learning.manage_courses");
  const courses = await listCourses();

  return (
    <>
      <PageHeader title="Manage courses" description="Create courses and upload their SCORM packages." />
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
                  {c.hasPackage ? "package uploaded" : "no package"}{c.isActive ? "" : " · inactive"}{c.assignToAll ? " · all depts" : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Replace the edit page**

Replace the entire contents of `src/app/learning/manage/[courseId]/page.tsx` with (Modules section → SCORM upload):

```tsx
import { notFound } from "next/navigation";
import { requirePermission } from "@/platform/auth/session";
import { prisma } from "@/platform/db";
import { PageHeader } from "@/platform/ui/page-header";
import { getCourseForEdit } from "@/modules/learning/services/courses";
import { updateCourseAction, setAssignmentAction, uploadPackageAction } from "../actions";

export default async function EditCoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  await requirePermission("learning.manage_courses");
  const { courseId } = await params;
  const course = await getCourseForEdit(courseId);
  if (!course) notFound();
  const departments = await prisma.department.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
  const assignedDeptIds = new Set(course.departments.map((d) => d.departmentId));

  return (
    <>
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
          <h2 className="font-medium">SCORM package</h2>
          <p className="text-sm text-slate-500">
            {course.scormEntryHref
              ? `Uploaded${course.scormUploadedAt ? ` ${course.scormUploadedAt.toLocaleDateString()}` : ""} · launch: ${course.scormEntryHref} · SCORM ${course.scormVersion ?? "1.2"}`
              : "No package uploaded yet."}
          </p>
          <form action={uploadPackageAction} encType="multipart/form-data" className="space-y-2 rounded border border-slate-200 p-3">
            <input type="hidden" name="courseId" value={course.id} />
            <input type="file" name="package" accept=".zip,application/zip" required className="block text-sm" />
            <p className="text-xs text-slate-400">Export from eXeLearning as SCORM 1.2, then upload the .zip. Uploading replaces any existing package.</p>
            <button className="rounded bg-slate-800 px-3 py-1.5 text-white" type="submit">{course.scormEntryHref ? "Replace package" : "Upload package"}</button>
          </form>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 3: Verify compile**

Run: `npx tsc --noEmit 2>&1 | grep "learning/manage" || echo "manage clean"`
Expected: `manage clean`.

- [ ] **Step 4: Commit**

```bash
git add src/app/learning/manage/page.tsx src/app/learning/manage/[courseId]/page.tsx
git commit -m "feat(learning): manage UI with SCORM package upload"
```

---

## Task 15: Learner list + dashboard pages

**Files:**
- Modify: `src/app/learning/page.tsx`
- Modify: `src/app/learning/dashboard/page.tsx`

- [ ] **Step 1: Replace the learner list page**

Replace the entire contents of `src/app/learning/page.tsx` with (status badge has three states, no module counts):

```tsx
import Link from "next/link";
import { requireModuleAccess } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { getMyCourses } from "@/modules/learning/services/enrollment";

const LABEL = { COMPLETE: "Complete", IN_PROGRESS: "In progress", NOT_STARTED: "Not started" } as const;

export default async function LearningPage() {
  const person = await requireModuleAccess("learning");
  const courses = await getMyCourses(person.personId);

  return (
    <>
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
                {LABEL[c.status]}
              </span>
            </div>
            {c.description && <p className="mt-1 text-sm text-slate-500">{c.description}</p>}
          </Link>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Replace the dashboard page**

Replace the entire contents of `src/app/learning/dashboard/page.tsx` with (Score column, Reset button keyed by courseId; no locked/quiz logic):

```tsx
import { requirePermission } from "@/platform/auth/session";
import { PageHeader } from "@/platform/ui/page-header";
import { listCoursesForDashboard, getCourseCompletion } from "@/modules/learning/services/dashboard";
import { resetCourseProgressAction } from "./actions";

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
    <>
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
            <tr><th className="py-2">Name</th><th>Dept</th><th>Status</th><th>Score</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.personId} className="border-b border-slate-100">
                <td className="py-2">{r.name}</td>
                <td>{r.departmentCode}</td>
                <td>{r.status === "COMPLETE" ? "Complete" : r.status === "IN_PROGRESS" ? "In progress" : "Not started"}</td>
                <td>{r.scoreRaw != null ? `${r.scoreRaw}%` : ""}</td>
                <td className="text-right text-xs text-slate-400">
                  {r.completedAt ? r.completedAt.toLocaleDateString() : ""}
                  {r.status !== "NOT_STARTED" && selected && (
                    <form action={resetCourseProgressAction} className="inline ml-2">
                      <input type="hidden" name="personId" value={r.personId} />
                      <input type="hidden" name="courseId" value={selected} />
                      <button type="submit" className="rounded bg-slate-200 px-2 py-0.5 text-slate-700 text-xs hover:bg-slate-300">
                        Reset
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="py-3 text-slate-500">No learners for this course.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
```

- [ ] **Step 3: Verify compile**

Run: `npx tsc --noEmit 2>&1 | grep -E "learning/page|learning/dashboard/page" || echo "pages clean"`
Expected: `pages clean`.

- [ ] **Step 4: Commit**

```bash
git add src/app/learning/page.tsx src/app/learning/dashboard/page.tsx
git commit -m "feat(learning): learner list + completion dashboard UI for SCORM"
```

---

## Task 16: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: exit 0, no errors. (If a stale `.next/dev/types` error about learning routes appears, it clears after the build in Step 4.)

- [ ] **Step 2: Lint the learning surfaces**

Run: `npx eslint src/app/learning src/modules/learning src/platform/storage.ts`
Expected: no errors. (Module-layering: `src/app/*` and `src/modules/learning/*` may import `@/platform/*`; nothing imports across modules.)

- [ ] **Step 3: Run the learning test suite**

Run: `npx vitest run src/modules/learning`
Expected: PASS — manifest (4), status (6), packages (4), courses (6), enrollment (5), dashboard (3), assignment (existing, unchanged). No references to removed models.

- [ ] **Step 4: Production build**

Run: `npx next build`
Expected: build succeeds; route list includes `/learning`, `/learning/[courseId]`, `/learning/play/[courseId]/[...path]`, `/learning/manage`, `/learning/manage/[courseId]`, `/learning/dashboard`.

- [ ] **Step 5: Full test suite (sanity)**

Run: `npm test`
Expected: PASS. (Known-environmental: the schedule-builder + 2 email tests can flake under full-suite load against the remote Neon pooler; if they fail, re-run them in isolation to confirm they pass — that is pre-existing and unrelated to this work.)

- [ ] **Step 6: Commit any final touch-ups**

```bash
git add -A
git commit -m "chore(learning): verification pass for SCORM packages" --allow-empty
```

---

## Manual smoke test (human, post-merge or on a preview deploy)

Cannot be automated (needs an interactive login + a real eXeLearning export). After deploy:

1. As an admin with `learning.manage_courses`: create a course, assign a department, upload a real eXeLearning **SCORM 1.2** export (`.zip`). Confirm the edit page shows "package uploaded" with the launch file.
2. As a volunteer in that department: open the course, confirm the eXeLearning content renders in the iframe and navigation works.
3. Complete the lesson (and its quiz, if any). Confirm the learner list flips to "Complete" and, with eXeLearning's "Automatically save the score" enabled, the dashboard shows the score.
4. As the admin: confirm the dashboard row shows Complete + score + date; use **Reset** and confirm it returns to Not started.

---

## Self-review notes (addressed)

- **Spec coverage:** ingest (T6), same-origin serve (T11), runtime/player (T13), persist+derive (T8), dashboard+score+reset (T9/T15), manage upload (T12/T14), schema reshape + settings/quiz removal (T1), `gradeQuiz` left intact (untouched list), fast-forward constraint is documented-only (no task, by design). Dep count is **three** (`scorm-again`, `fflate`, `fast-xml-parser`) — the spec said two; `fast-xml-parser` was added for robust manifest parsing.
- **Type consistency:** `CmiSnapshot` (engine/service) is the single shape used by `persistCmi`, `persistCmiAction`, and `ScormPlayer`. `LearnerStatus` (`NOT_STARTED|IN_PROGRESS|COMPLETE`) is shared by learner reads + dashboard. `contentTypeFor` is defined once in `packages.ts` and reused by the route. `isCourseAssignedTo` is the single assignment check used by both the service reads and the play route.
- **Known follow-up (out of scope):** optional hub-side "reject impossibly-fast completion" backstop; per-permission nav-tab hiding (module-wide concern).
