# Multi-SCO Learning Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hub's learning module play multi-page (multi-SCO) eXeLearning packages — render a table-of-contents so every page is reachable, and mark a course COMPLETE only when *every* SCO is complete.

**Architecture:** The manifest parser already finds one launch href; extend it to return the full ordered list of SCOs from the organization tree. Store that list on the `Course` (`scormScos` JSON). Per-SCO CMI/resume state moves to a new `ScoProgress` table; `CourseProgress` stays as the course-level *rollup* record (its `lessonStatus`/`status`/`completedAt` keep driving the dashboard and "My Courses" unchanged). The player gains a TOC sidebar and switches SCOs via an in-page `about:blank` handoff (so the parent page — and its persistence fetches — survive while the outgoing SCO unloads and stamps completion).

**Tech Stack:** Next.js App Router, React client components, Prisma + Postgres (Neon), `scorm-again` (SCORM 1.2 runtime), `fast-xml-parser`, `fflate`, Vitest.

---

## Why (root cause this plan fixes)

The uploaded package (`testing123_scorm`) has **two SCOs** in `imsmanifest.xml` — `index.html` ("hb") and `html/ytf.html` ("ytf"). Two bugs result from the "one course = one SCO" assumption:

1. **Only page 1 is reachable.** `parseManifest` returns only the first item's href; the player loads only that file. eXeLearning ships *no* in-page menu in SCORM mode (`class="...siteNav-hidden"`) — the LMS is expected to render the TOC. The hub doesn't, so SCO #2 is unreachable.
2. **Instant "completed".** eXe's `libs/SCOFunctions.js` `unloadPage()` sets `lesson_status = "completed"` on unload for any plain content page. The hub maps `"completed"` → COMPLETE and stores a single status per course, so viewing SCO #1 flags the whole course done.

This plan parses all SCOs, lets the learner reach each one, tracks completion per SCO, and rolls up to COMPLETE only when all are done.

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/modules/learning/engine/manifest.ts` | Parse imsmanifest → ordered SCO list | Modify |
| `src/modules/learning/engine/manifest.test.ts` | Manifest parser tests | Modify |
| `src/modules/learning/engine/status.ts` | SCORM status mapping + course rollup | Modify |
| `src/modules/learning/engine/status.test.ts` | Status/rollup tests | Modify |
| `prisma/schema.prisma` | `Course.scormScos` JSON + `ScoProgress` model + back-relations | Modify |
| `src/modules/learning/services/packages.ts` | Persist SCO list on ingest | Modify |
| `src/modules/learning/services/test-fixtures.ts` | Multi-SCO zip fixture | Modify |
| `src/modules/learning/services/packages.test.ts` | Ingest tests (SCO list) | Modify |
| `src/modules/learning/services/enrollment.ts` | `persistScoCmi` + per-SCO `getCourseForLearner` + `courseScos` helper | Modify |
| `src/modules/learning/services/enrollment.test.ts` | Enrollment/rollup tests | Modify |
| `src/app/learning/actions.ts` | Server action gains `scoId` | Modify |
| `src/app/learning/[courseId]/ScormPlayer.tsx` | TOC + in-page SCO handoff | Modify |
| `src/app/learning/[courseId]/page.tsx` | Pass `scos` to player | Modify |

`dashboard.ts` and `getMyCourses` are **intentionally untouched** — they read `CourseProgress` via `deriveStatus(lessonStatus)`, which this plan keeps maintaining as the rollup.

---

## Task 1: Manifest parser returns the ordered SCO list

**Files:**
- Modify: `src/modules/learning/engine/manifest.ts`
- Test: `src/modules/learning/engine/manifest.test.ts`

- [ ] **Step 1: Write failing tests for the SCO list**

Append these tests inside the `describe("parseManifest", …)` block in `src/modules/learning/engine/manifest.test.ts`:

```ts
const MULTI = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MAN-2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>Course</title>
      <item identifier="ITEM-A" identifierref="RES-A"><title>hb</title></item>
      <item identifier="ITEM-B" identifierref="RES-B"><title>ytf</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-A" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource>
    <resource identifier="RES-B" adlcp:scormtype="sco" href="html/ytf.html"><file href="html/ytf.html"/></resource>
  </resources>
</manifest>`;

it("returns every SCO in organization order with id, title and href", () => {
  const parsed = parseManifest(MULTI);
  expect(parsed.scos).toEqual([
    { id: "ITEM-A", title: "hb", href: "index.html" },
    { id: "ITEM-B", title: "ytf", href: "html/ytf.html" },
  ]);
  expect(parsed.entryHref).toBe("index.html");
});

it("single-item manifest yields a one-entry SCO list", () => {
  expect(parseManifest(MANIFEST).scos).toEqual([
    { id: "ITEM-1", title: "Lesson", href: "index.html" },
  ]);
});

it("falls back to a single synthetic SCO when items lack identifierref", () => {
  const xml = MANIFEST.replace('identifierref="RES-1"', "");
  const parsed = parseManifest(xml);
  expect(parsed.scos).toHaveLength(1);
  expect(parsed.scos[0].href).toBe("index.html");
  expect(parsed.entryHref).toBe("index.html");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/learning/engine/manifest.test.ts`
Expected: FAIL — `parsed.scos` is undefined (`expected undefined to equal [ … ]`).

- [ ] **Step 3: Implement the SCO walk**

Replace the contents of `src/modules/learning/engine/manifest.ts` with:

```ts
import { XMLParser } from "fast-xml-parser";

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/** One launchable SCO from the manifest organization (a "page"). */
export type ScoEntry = {
  /** Stable identifier: the <item> identifier (falls back to href). */
  id: string;
  /** Display title for the table of contents. */
  title: string;
  /** Launch file relative to the package root (e.g. "html/ytf.html"). */
  href: string;
};

export type ParsedManifest = {
  /** First SCO's launch file — kept for back-compat (e.g. "index.html"). */
  entryHref: string;
  /** SCORM schema version, e.g. "1.2". */
  version: string;
  /** Every SCO, in organization order. Always at least one entry. */
  scos: ScoEntry[];
};

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Pull plain text out of an <item><title> value (string, number, or {#text}). */
function textOf(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    const t = (v as Record<string, unknown>)["#text"];
    return typeof t === "string" ? t.trim() || null : null;
  }
  return null;
}

/** Depth-first walk of the item tree, collecting every item that resolves to a resource href. */
function collectScos(
  item: Record<string, unknown>,
  resources: Record<string, unknown>[],
  out: ScoEntry[]
): void {
  const ref = item["@_identifierref"];
  if (typeof ref === "string" && ref) {
    const res = resources.find((r) => r["@_identifier"] === ref);
    const href = res?.["@_href"];
    if (typeof href === "string" && href) {
      const id = item["@_identifier"];
      out.push({
        id: typeof id === "string" && id ? id : href,
        title: textOf(item["title"]) ?? href,
        href,
      });
    }
  }
  for (const child of toArray(item["item"] as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    collectScos(child, resources, out);
  }
}

/**
 * Parse an imsmanifest.xml string into the ordered SCO list + version.
 *
 * Resolution: pick the default organization (or the first), walk its items
 * depth-first, and emit one SCO per item that resolves to a <resource href>. If no
 * item references a resource, fall back to the first resource that has an href.
 * Throws ManifestError when the XML is unparseable or no launchable resource exists.
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

  const orgs = manifest["organizations"] as Record<string, unknown> | undefined;
  const orgList = toArray(orgs?.["organization"] as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const defaultId = orgs?.["@_default"];
  const org = orgList.find((o) => o["@_identifier"] === defaultId) ?? orgList[0];

  const scos: ScoEntry[] = [];
  if (org) {
    for (const item of toArray(org["item"] as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
      collectScos(item, resources, scos);
    }
  }

  if (scos.length > 0) {
    return { entryHref: scos[0].href, version: schemaVersion(manifest), scos };
  }

  // Fallback: first resource with an href (prefer a SCO) → a single synthetic SCO.
  const sco = resources.find((r) => r["@_scormtype"] === "sco" && typeof r["@_href"] === "string");
  const any = sco ?? resources.find((r) => typeof r["@_href"] === "string");
  const href = any?.["@_href"];
  if (typeof href === "string" && href) {
    return {
      entryHref: href,
      version: schemaVersion(manifest),
      scos: [{ id: href, title: href, href }],
    };
  }

  throw new ManifestError("imsmanifest.xml has no launchable resource (no <resource href>).");
}

function schemaVersion(manifest: Record<string, unknown>): string {
  const md = manifest["metadata"] as Record<string, unknown> | undefined;
  const v = md?.["schemaversion"];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return "1.2";
}
```

- [ ] **Step 4: Run the manifest tests to verify they pass**

Run: `npx vitest run src/modules/learning/engine/manifest.test.ts`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/modules/learning/engine/manifest.ts src/modules/learning/engine/manifest.test.ts
git commit -m "feat(learning): parse full SCO list from SCORM manifest"
```

---

## Task 2: Course-level rollup status helper

**Files:**
- Modify: `src/modules/learning/engine/status.ts`
- Test: `src/modules/learning/engine/status.test.ts`

- [ ] **Step 1: Write failing tests for `rollupStatus`**

Append to `src/modules/learning/engine/status.test.ts` (add `rollupStatus` to the existing import from `./status`):

```ts
describe("rollupStatus", () => {
  it("is COMPLETE only when every SCO is complete", () => {
    expect(rollupStatus(["completed", "passed"]).status).toBe("COMPLETE");
    expect(rollupStatus(["completed", "incomplete"]).status).toBe("IN_PROGRESS");
    expect(rollupStatus(["completed", null]).status).toBe("IN_PROGRESS");
  });

  it("is IN_PROGRESS for an empty SCO list (nothing to complete yet)", () => {
    expect(rollupStatus([]).status).toBe("IN_PROGRESS");
    expect(rollupStatus([]).completed).toBe(false);
  });
});
```

> If `status.test.ts` does not already import `describe`, add it: `import { describe, expect, it } from "vitest";`

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/modules/learning/engine/status.test.ts`
Expected: FAIL — `rollupStatus is not a function`.

- [ ] **Step 3: Implement `rollupStatus`**

Append to `src/modules/learning/engine/status.ts`:

```ts
/**
 * Roll per-SCO lesson_status values up to a course-level status. A course is
 * COMPLETE only when it has at least one SCO and every SCO is individually
 * complete; otherwise it is IN_PROGRESS.
 */
export function rollupStatus(scoStatuses: Array<string | null | undefined>): DerivedStatus {
  const completed = scoStatuses.length > 0 && scoStatuses.every((s) => deriveStatus(s).completed);
  return { status: completed ? "COMPLETE" : "IN_PROGRESS", completed };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/modules/learning/engine/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/learning/engine/status.ts src/modules/learning/engine/status.test.ts
git commit -m "feat(learning): add course rollup status helper"
```

---

## Task 3: Schema — `Course.scormScos` + `ScoProgress` model

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add the `scormScos` column to `Course`**

In `model Course` (around line 1043), after the `scormUploadedAt DateTime?` line, add:

```prisma
  /// Ordered SCO list from imsmanifest.xml: [{ id, title, href }]. Null = legacy single-SCO package.
  scormScos       Json?
```

And in the same model's relation block (after `progress CourseProgress[]`), add:

```prisma
  scoProgress     ScoProgress[]
```

- [ ] **Step 2: Add the `scoProgress` back-relation to `Person`**

In `model Person`, immediately after the line `courseProgress            CourseProgress[]` (line 112), add:

```prisma
  scoProgress               ScoProgress[]
```

- [ ] **Step 3: Add the `ScoProgress` model**

After `model CourseProgress { … }` (ends ~line 1080), add:

```prisma
model ScoProgress {
  id             String    @id @default(cuid())
  personId       String
  courseId       String
  /// Manifest <item> identifier (matches Course.scormScos[].id).
  scoId          String
  completedAt    DateTime?
  /// Raw cmi.core.lesson_status reported by this SCO.
  lessonStatus   String?
  /// cmi.core.score.raw when reported; null otherwise.
  scoreRaw       Int?
  /// cmi.suspend_data for this SCO -- can be large.
  suspendData    String?   @db.Text
  /// cmi.core.lesson_location for resume.
  lessonLocation String?
  person         Person    @relation(fields: [personId], references: [id], onDelete: Cascade)
  course         Course    @relation(fields: [courseId], references: [id], onDelete: Cascade)

  @@unique([personId, courseId, scoId])
  @@index([courseId])
}
```

- [ ] **Step 4: Create and apply the migration**

Run: `npx prisma migrate dev --name multi_sco_progress`
Expected: a new migration directory under `prisma/migrations/`, Prisma Client regenerated, no errors.

> If the local DB is unavailable, run `npx prisma generate` to update the client types and create the migration separately when the DB is reachable. Do not hand-edit generated client files.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(learning): add ScoProgress table and Course.scormScos"
```

---

## Task 4: Ingest stores the SCO list

**Files:**
- Modify: `src/modules/learning/services/test-fixtures.ts`
- Modify: `src/modules/learning/services/packages.ts`
- Test: `src/modules/learning/services/packages.test.ts`

- [ ] **Step 1: Add a multi-SCO fixture**

Append to `src/modules/learning/services/test-fixtures.ts`:

```ts
const MULTI_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MAN-2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>Course</title>
      <item identifier="ITEM-A" identifierref="RES-A"><title>hb</title></item>
      <item identifier="ITEM-B" identifierref="RES-B"><title>ytf</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-A" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource>
    <resource identifier="RES-B" adlcp:scormtype="sco" href="html/ytf.html"><file href="html/ytf.html"/></resource>
  </resources>
</manifest>`;

/** A two-SCO SCORM package: manifest + two page files. */
export function makeMultiScoZip(): Buffer {
  const files: Record<string, Uint8Array> = {
    "imsmanifest.xml": strToU8(MULTI_MANIFEST),
    "index.html": strToU8("<!doctype html><title>hb</title>"),
    "html/ytf.html": strToU8("<!doctype html><title>ytf</title>"),
  };
  return Buffer.from(zipSync(files));
}
```

- [ ] **Step 2: Write a failing ingest test**

Add to `src/modules/learning/services/packages.test.ts` (extend the import on line 7 to `import { makeScormZip, makeMultiScoZip } from "./test-fixtures";`):

```ts
it("stores the ordered SCO list on the course", async () => {
  const { manager, course } = await seed();
  await ingestScormPackage(course.id, makeMultiScoZip(), manager.id);

  const updated = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
  expect(updated.scormEntryHref).toBe("index.html");
  expect(updated.scormScos).toEqual([
    { id: "ITEM-A", title: "hb", href: "index.html" },
    { id: "ITEM-B", title: "ytf", href: "html/ytf.html" },
  ]);
  expect(await getObject(`scorm/${course.id}/html/ytf.html`)).not.toBeNull();
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/modules/learning/services/packages.test.ts`
Expected: FAIL — `updated.scormScos` is `null`.

- [ ] **Step 4: Persist `scos` in `ingestScormPackage`**

In `src/modules/learning/services/packages.ts`, change the `prisma.course.update` data block (lines 102-105) to:

```ts
  await prisma.course.update({
    where: { id: courseId },
    data: {
      scormEntryHref: parsed.entryHref,
      scormVersion: parsed.version,
      scormScos: parsed.scos as unknown as Prisma.InputJsonValue,
      scormUploadedAt: new Date(),
    },
  });
```

And update the audit `after` payload (line 112) to include the SCO count:

```ts
    after: { entryHref: parsed.entryHref, version: parsed.version, fileCount: files.length, scoCount: parsed.scos.length },
```

Add the `Prisma` import at the top of the file (after the existing imports):

```ts
import { Prisma } from "@prisma/client";
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/modules/learning/services/packages.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add src/modules/learning/services/packages.ts src/modules/learning/services/packages.test.ts src/modules/learning/services/test-fixtures.ts
git commit -m "feat(learning): persist SCO list on package ingest"
```

---

## Task 5: Per-SCO persistence + rollup in the enrollment service

**Files:**
- Modify: `src/modules/learning/services/enrollment.ts`
- Test: `src/modules/learning/services/enrollment.test.ts`

This task replaces `persistCmi` with `persistScoCmi(personId, courseId, scoId, cmi)` and reshapes `getCourseForLearner` to return per-SCO data plus the rollup status.

- [ ] **Step 1: Rewrite the enrollment tests for per-SCO behaviour**

Replace the three `persistCmi` tests (lines 54-94) in `src/modules/learning/services/enrollment.test.ts`, and update the import on line 5 to use `persistScoCmi`:

```ts
import { getMyCourses, getCourseForLearner, persistScoCmi, isCourseAssignedTo } from "./enrollment";
```

Update `seed()` so the assigned course is a real two-SCO course (replace the `course` creation, lines 18-26):

```ts
  const course = await prisma.course.create({
    data: {
      title: "Intro",
      description: "d",
      scormEntryHref: "index.html",
      scormVersion: "1.2",
      scormScos: [
        { id: "ITEM-A", title: "hb", href: "index.html" },
        { id: "ITEM-B", title: "ytf", href: "html/ytf.html" },
      ],
      departments: { create: [{ departmentId: dept.id }] },
    },
  });
```

Then replace the old `persistCmi …` tests with:

```ts
it("getCourseForLearner returns every SCO with its own resume state", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "completed", scoreRaw: null, suspendData: "a=1", lessonLocation: "1",
  });
  const row = await getCourseForLearner(learner.id, course.id);
  expect(row.scos.map((s) => s.id)).toEqual(["ITEM-A", "ITEM-B"]);
  expect(row.scos[0].cmi.suspendData).toBe("a=1");
  expect(row.scos[1].cmi.lessonStatus).toBeNull();
});

it("course is IN_PROGRESS until every SCO completes, then COMPLETE", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  expect((await getCourseForLearner(learner.id, course.id)).status).toBe("IN_PROGRESS");

  await persistScoCmi(learner.id, course.id, "ITEM-B", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  expect((await getCourseForLearner(learner.id, course.id)).status).toBe("COMPLETE");
});

it("stamps course completedAt once and preserves it across later commits", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  await persistScoCmi(learner.id, course.id, "ITEM-B", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  const first = await prisma.courseProgress.findFirstOrThrow({ where: { personId: learner.id, courseId: course.id } });

  await persistScoCmi(learner.id, course.id, "ITEM-B", {
    lessonStatus: "completed", scoreRaw: 95, suspendData: "b=9", lessonLocation: "9",
  });
  const again = await prisma.courseProgress.findFirstOrThrow({ where: { personId: learner.id, courseId: course.id } });
  expect(again.completedAt?.getTime()).toBe(first.completedAt?.getTime());
});

it("rounds a fractional SCO score to fit the Int column", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "passed", scoreRaw: 83.5, suspendData: null, lessonLocation: null,
  });
  const row = await getCourseForLearner(learner.id, course.id);
  expect(row.scos[0].cmi.scoreRaw).toBe(84);
});

it("getMyCourses reports COMPLETE only after the rollup completes", async () => {
  const { learner, course } = await seed();
  await persistScoCmi(learner.id, course.id, "ITEM-A", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  expect((await getMyCourses(learner.id))[0].status).toBe("IN_PROGRESS");
  await persistScoCmi(learner.id, course.id, "ITEM-B", {
    lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null,
  });
  expect((await getMyCourses(learner.id))[0].status).toBe("COMPLETE");
});

it("persistScoCmi refuses an unassigned course", async () => {
  const { learner, unassigned } = await seed();
  await expect(
    persistScoCmi(learner.id, unassigned.id, "ITEM-A", { lessonStatus: "completed", scoreRaw: null, suspendData: null, lessonLocation: null })
  ).rejects.toBeInstanceOf(LearningAuthError);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/modules/learning/services/enrollment.test.ts`
Expected: FAIL — `persistScoCmi` is not exported; `row.scos` is undefined.

- [ ] **Step 3: Implement the new service API**

In `src/modules/learning/services/enrollment.ts`:

(a) Update the imports at the top:

```ts
import { prisma } from "@/platform/db";
import { coursesForMember, type AssignableCourse } from "../engine/assignment";
import { deriveStatus, rollupStatus } from "../engine/status";
import type { ScoEntry } from "../engine/manifest";
import { LearningAuthError } from "./errors";
```

(b) Add a `courseScos` helper near the top (after `isCourseAssignedTo`):

```ts
/**
 * The course's SCO list. Uses the stored manifest list; for a legacy package
 * (scormScos null) synthesizes a single SCO ("sco-0") from scormEntryHref so old
 * courses keep working without re-ingest.
 */
function courseScos(course: { scormScos: unknown; scormEntryHref: string | null; title: string }): ScoEntry[] {
  if (Array.isArray(course.scormScos)) return course.scormScos as ScoEntry[];
  if (course.scormEntryHref) return [{ id: "sco-0", title: course.title, href: course.scormEntryHref }];
  return [];
}
```

(c) Replace the `LearnerCourse` type and `getCourseForLearner` (lines 76-112) with:

```ts
export type LearnerSco = {
  id: string;
  title: string;
  href: string;
  cmi: CmiSnapshot;
};

export type LearnerCourse = {
  id: string;
  title: string;
  description: string | null;
  status: LearnerStatus;
  scos: LearnerSco[];
};

export async function getCourseForLearner(personId: string, courseId: string): Promise<LearnerCourse> {
  if (!(await isCourseAssignedTo(personId, courseId))) {
    throw new LearningAuthError("This course is not assigned to you.");
  }
  const course = await prisma.course.findUniqueOrThrow({ where: { id: courseId } });
  const scos = courseScos(course);

  const scoRows = await prisma.scoProgress.findMany({ where: { personId, courseId } });
  const byId = new Map(scoRows.map((r) => [r.scoId, r]));

  const rollup = await prisma.courseProgress.findUnique({
    where: { personId_courseId: { personId, courseId } },
    select: { status: true },
  });
  const status: LearnerStatus = !rollup ? "NOT_STARTED" : rollup.status;

  return {
    id: course.id,
    title: course.title,
    description: course.description,
    status,
    scos: scos.map((s) => {
      const r = byId.get(s.id);
      return {
        id: s.id,
        title: s.title,
        href: s.href,
        cmi: {
          lessonStatus: r?.lessonStatus ?? null,
          scoreRaw: r?.scoreRaw ?? null,
          suspendData: r?.suspendData ?? null,
          lessonLocation: r?.lessonLocation ?? null,
        },
      };
    }),
  };
}
```

(d) Replace `persistCmi` (lines 126-152) with `persistScoCmi`:

```ts
/**
 * Persist one SCO's CMI snapshot, then recompute the course rollup. Idempotent:
 * re-commits update state; per-SCO and course completedAt are each stamped once
 * (the first time that level becomes COMPLETE) and preserved afterwards.
 *
 * CourseProgress remains the course-level rollup record (its status/lessonStatus/
 * completedAt drive the dashboard and "My Courses"); per-SCO state lives in
 * ScoProgress.
 */
export async function persistScoCmi(
  personId: string,
  courseId: string,
  scoId: string,
  cmi: CmiSnapshot
): Promise<void> {
  if (!(await isCourseAssignedTo(personId, courseId))) {
    throw new LearningAuthError("This course is not assigned to you.");
  }

  // 1. Upsert this SCO's state.
  const sco = deriveStatus(cmi.lessonStatus);
  const existingSco = await prisma.scoProgress.findUnique({
    where: { personId_courseId_scoId: { personId, courseId, scoId } },
    select: { completedAt: true },
  });
  const scoCompletedAt = sco.completed ? (existingSco?.completedAt ?? new Date()) : null;
  const scoData = {
    completedAt: scoCompletedAt,
    lessonStatus: cmi.lessonStatus,
    scoreRaw: cmi.scoreRaw == null ? null : Math.round(cmi.scoreRaw),
    suspendData: cmi.suspendData,
    lessonLocation: cmi.lessonLocation,
  };
  await prisma.scoProgress.upsert({
    where: { personId_courseId_scoId: { personId, courseId, scoId } },
    create: { personId, courseId, scoId, ...scoData },
    update: scoData,
  });

  // 2. Recompute the course rollup over every SCO in the manifest.
  const course = await prisma.course.findUniqueOrThrow({
    where: { id: courseId },
    select: { scormScos: true, scormEntryHref: true, title: true },
  });
  const scos = courseScos(course);
  const rows = await prisma.scoProgress.findMany({
    where: { personId, courseId },
    select: { scoId: true, lessonStatus: true },
  });
  const statusById = new Map(rows.map((r) => [r.scoId, r.lessonStatus]));
  const roll = rollupStatus(scos.map((s) => statusById.get(s.id) ?? null));

  const existingCourse = await prisma.courseProgress.findUnique({
    where: { personId_courseId: { personId, courseId } },
    select: { completedAt: true },
  });
  const completedAt = roll.completed ? (existingCourse?.completedAt ?? new Date()) : null;

  // lessonStatus is a rollup token so existing readers (dashboard, getMyCourses)
  // keep deriving the course status from CourseProgress unchanged.
  const courseData = {
    status: roll.status,
    completedAt,
    lessonStatus: roll.completed ? "completed" : "incomplete",
    scoreRaw: null,
    suspendData: null,
    lessonLocation: null,
  };
  await prisma.courseProgress.upsert({
    where: { personId_courseId: { personId, courseId } },
    create: { personId, courseId, ...courseData },
    update: courseData,
  });
}
```

> Leave `CmiSnapshot` (lines 114-119) and `getMyCourses` (lines 54-74) as they are — `getMyCourses` already derives status from `CourseProgress.lessonStatus`, which step (d) keeps maintaining.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/modules/learning/services/enrollment.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/learning/services/enrollment.ts src/modules/learning/services/enrollment.test.ts
git commit -m "feat(learning): per-SCO persistence with course completion rollup"
```

---

## Task 6: Server action takes a `scoId`

**Files:**
- Modify: `src/app/learning/actions.ts`

- [ ] **Step 1: Update the action**

Replace `src/app/learning/actions.ts` with:

```ts
"use server";
import { requirePermission } from "@/platform/auth/session";
import { persistScoCmi, type CmiSnapshot } from "@/modules/learning/services/enrollment";

/** Called from the SCORM player (client) on each commit/finish, per SCO. */
export async function persistCmiAction(courseId: string, scoId: string, cmi: CmiSnapshot): Promise<void> {
  const person = await requirePermission("learning.access");
  await persistScoCmi(person.personId, courseId, scoId, cmi);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors in `actions.ts` (the player still calls the old 2-arg signature — fixed in Task 7; if running tasks strictly in order, expect one error in `ScormPlayer.tsx` here, resolved next task).

- [ ] **Step 3: Commit**

```bash
git add src/app/learning/actions.ts
git commit -m "feat(learning): thread scoId through the persist action"
```

---

## Task 7: Player — TOC sidebar + in-page SCO handoff

**Files:**
- Modify: `src/app/learning/[courseId]/ScormPlayer.tsx`

The player must let the learner reach every SCO and capture each SCO's completion. SCO switching uses an in-page `about:blank` handoff (not a React key-remount and not a top-page reload) so the **parent document stays alive** while the outgoing SCO unloads — eXe stamps `lesson_status="completed"` in its `unloadPage`, which fires `LMSFinish` on the still-current `window.API`, and our persistence fetch (issued from the surviving parent) completes.

This task is verified by typecheck + manual run (Task 9), not a unit test — the logic is imperative DOM/iframe glue.

- [ ] **Step 1: Replace the component**

Replace `src/app/learning/[courseId]/ScormPlayer.tsx` with:

```tsx
"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { Scorm12API } from "scorm-again";
import { persistCmiAction } from "../actions";
import { deriveStatus, parseScore } from "@/modules/learning/engine/status";
import type { LearnerSco } from "@/modules/learning/services/enrollment";

type Props = {
  courseId: string;
  scos: LearnerSco[];
};

/**
 * Hosts a SCORM 1.2 runtime as window.API and renders one SCO at a time in an
 * iframe, with a table of contents for multi-SCO packages.
 *
 * SCO switching (goTo) does an in-page handoff rather than a remount/reload: we
 * point the iframe at about:blank first, so the outgoing SCO unloads and fires
 * LMSFinish against the still-current window.API (eXeLearning stamps completion in
 * its unloadPage). Because only the iframe navigates -- not the parent -- the
 * persistence fetch issued from this component survives. We then install the next
 * SCO's API and point the iframe at it.
 */
export function ScormPlayer({ courseId, scos }: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const apiRef = useRef<InstanceType<typeof Scorm12API> | null>(null);
  const pendingSaveRef = useRef<Promise<void>>(Promise.resolve());
  const switchingRef = useRef(false);

  // Build a fresh API for one SCO: seed saved state, wire commit/finish
  // persistence (tagged with this SCO's id), and install it as window.API.
  function installApi(sco: LearnerSco) {
    const api = new Scorm12API({ autocommit: true, autocommitSeconds: 30, logLevel: 4 });
    if (sco.cmi.lessonStatus) api.cmi.core.lesson_status = sco.cmi.lessonStatus;
    if (sco.cmi.lessonLocation) api.cmi.core.lesson_location = sco.cmi.lessonLocation;
    if (sco.cmi.scoreRaw != null) api.cmi.core.score.raw = String(sco.cmi.scoreRaw);
    if (sco.cmi.suspendData) api.cmi.suspend_data = sco.cmi.suspendData;

    const snapshot = () => ({
      lessonStatus: api.cmi.core.lesson_status || null,
      scoreRaw: parseScore(api.cmi.core.score.raw),
      suspendData: api.cmi.suspend_data || null,
      lessonLocation: api.cmi.core.lesson_location || null,
    });
    const save = () => {
      const p = persistCmiAction(courseId, sco.id, snapshot()).catch(() => {});
      pendingSaveRef.current = p;
      return p;
    };
    api.on("LMSCommit", save);
    api.on("LMSFinish", save);

    (window as unknown as { API: typeof api }).API = api;
    apiRef.current = api;
    return save;
  }

  // Initial mount: install the first SCO's API before paint, so the iframe (which
  // renders with the first SCO's src) finds window.API on load. Unmount: persist + remove.
  useLayoutEffect(() => {
    const save = installApi(scos[0]);
    return () => {
      save();
      delete (window as unknown as { API?: unknown }).API;
      apiRef.current = null;
    };
    // scos is a stable server-rendered snapshot for the life of this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function goTo(index: number) {
    if (index === activeIndex || switchingRef.current) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    switchingRef.current = true;
    try {
      await blankIframe(iframe); // outgoing SCO unloads -> LMSFinish on current API
      await pendingSaveRef.current; // let that completion write land
      delete (window as unknown as { API?: unknown }).API;
      apiRef.current = null;
      installApi(scos[index]); // window.API now points at the next SCO
      iframe.src = `/learning/play/${courseId}/${scos[index].href}`;
      setActiveIndex(index);
    } finally {
      switchingRef.current = false;
    }
  }

  const single = scos.length <= 1;

  return (
    <div className="flex flex-col gap-4 md:flex-row">
      {!single && (
        <nav aria-label="Course pages" className="md:w-56 md:shrink-0">
          <ol className="space-y-1">
            {scos.map((s, i) => {
              const isActive = i === activeIndex;
              const done = deriveStatus(s.cmi.lessonStatus).completed;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => goTo(i)}
                    aria-current={isActive ? "page" : undefined}
                    className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${
                      isActive
                        ? "bg-teal-50 font-medium text-teal-800"
                        : "text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] ${
                        done ? "border-teal-600 bg-teal-600 text-white" : "border-slate-300 text-slate-400"
                      }`}
                    >
                      {done ? "✓" : i + 1}
                    </span>
                    <span className="truncate">{s.title}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      )}
      <iframe
        ref={iframeRef}
        title="Course content"
        src={`/learning/play/${courseId}/${scos[0].href}`}
        className="h-[80vh] w-full rounded-xl border border-slate-200"
      />
    </div>
  );
}

/** Point an iframe at about:blank and resolve once that blank document has loaded. */
function blankIframe(iframe: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve) => {
    const onLoad = () => {
      iframe.removeEventListener("load", onLoad);
      resolve();
    };
    iframe.addEventListener("load", onLoad);
    iframe.src = "about:blank";
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (the player now matches the new `persistCmiAction(courseId, scoId, cmi)` signature and imports `LearnerSco`).

- [ ] **Step 3: Commit**

```bash
git add src/app/learning/[courseId]/ScormPlayer.tsx
git commit -m "feat(learning): TOC navigation and per-SCO playback in the player"
```

---

## Task 8: Course page passes the SCO list

**Files:**
- Modify: `src/app/learning/[courseId]/page.tsx`

- [ ] **Step 1: Update the page**

In `src/app/learning/[courseId]/page.tsx`, replace the player render block (lines 32-36) with:

```tsx
        {course.scos.length > 0 ? (
          <ScormPlayer courseId={course.id} scos={course.scos} />
        ) : (
          <p className="text-sm text-slate-500">This course has no content uploaded yet. Check back soon.</p>
        )}
```

(The completion banner above it — `course.status === "COMPLETE"` — is unchanged and now reflects the rollup.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/learning/[courseId]/page.tsx
git commit -m "feat(learning): render multi-SCO course player"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole learning test suite**

Run: `npx vitest run src/modules/learning`
Expected: PASS, no failures.

- [ ] **Step 2: Typecheck + lint the full project**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors. (If `npm run lint` is not the project's lint script, check `package.json` `scripts` and use the correct one.)

- [ ] **Step 3: Manual end-to-end with the real package**

This is the acceptance test for the original bug. Use the skill `verify` (or `run`) to drive the app:

1. Start the app: `npm run dev`.
2. As a learning manager, create a course and upload `/Users/jcarney/Downloads/testing123_scorm (2).zip` via `/admin` → learning manage (or `/learning/manage/<courseId>`).
3. Open the course as an assigned learner at `/learning/<courseId>`.
4. **Verify navigation:** a left-hand TOC shows two entries — "hb" and "ytf". Both are clickable; clicking "ytf" loads the second page's content in the iframe.
5. **Verify completion gating:** after viewing only "hb", the course is NOT marked complete (no "You have completed this course." banner; `/learning` shows it IN_PROGRESS). After viewing "ytf" as well (so both SCOs unload at least once), the banner appears and `/learning` shows COMPLETE.
6. Reload `/learning/<courseId>` and confirm the TOC check-marks and completion banner persist (server-side rollup is durable).

- [ ] **Step 4: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(learning): verify multi-SCO playback end-to-end"
```

---

## Notes / known limitations (intentional for v1)

- **TOC check-marks reflect server state at page load.** After switching SCOs in-page, a freshly-completed SCO's check-mark updates on the next full page load, not instantly. Correct completion is always persisted; only the live tick is deferred. (A follow-up could lift per-SCO status into React state updated from the save snapshot.)
- **Legacy single-SCO courses keep working** without re-upload: `courseScos` synthesizes a `"sco-0"` entry from `scormEntryHref` when `scormScos` is null. Re-uploading a package populates `scormScos`. Existing `CourseProgress` rows remain valid as the rollup.
- **Score rollup** is left null at the course level for multi-SCO courses (eXe content pages report no score). Per-SCO scores are stored in `ScoProgress.scoreRaw`. If a scored multi-SCO course needs an aggregate later, compute it in the rollup step.
- **Switch-time write race:** switching SCOs very rapidly could recompute the rollup before a completing write lands; autocommit (30s) and the unmount save reconcile it. `getCourseForLearner` always recomputes from stored rows, so the persisted state is the source of truth.

## Self-Review

- **Spec coverage:** (1) reach every page → Tasks 1,7,8 (SCO list + TOC + page). (2) complete only when all pages done → Tasks 2,5 (rollup + per-SCO persistence). Manifest/ingest/schema/action plumbing → Tasks 1,3,4,6. Verified end-to-end in Task 9.
- **Type consistency:** `ScoEntry {id,title,href}` (manifest) flows into `Course.scormScos` (Task 3/4), `courseScos()` (Task 5), and `LearnerSco` (Task 5) used by the player (Task 7) and page (Task 8). `persistCmiAction(courseId, scoId, cmi)` matches between action (Task 6) and player (Task 7). `rollupStatus` (Task 2) is consumed only in `persistScoCmi` (Task 5).
- **Placeholders:** none — every code step contains complete content.
