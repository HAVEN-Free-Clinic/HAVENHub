# Recruitment "Speed Score" (Easy Grader) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A keyboard-driven modal that lets a committee reviewer read a whole application on one page, press 1-5 to score, and jump straight to the next unscored applicant, with no page loads between applicants.

**Architecture:** A UI layer on the existing committee-scoring pipeline. The applicant-list server page passes a lightweight queue plus two bound server actions to a client `SpeedScoreModal`. The modal lazily fetches each applicant's condensed view model (prefetching the next), and each 1-5 keypress calls the existing `submitCommitteeScore` upsert. No schema change.

**Tech Stack:** Next.js App Router (RSC + server actions), React client components, Prisma, TypeScript, vitest (unit/service), Playwright (e2e), Tailwind via `@/platform/ui/*` primitives.

Spec: `docs/superpowers/specs/2026-07-15-recruitment-speed-scoring-design.md`.

## Global Constraints

- **No em-dashes** anywhere (the `local/no-em-dash` ESLint rule bans them across `src/**`, and it is a standing author preference). Use colons, commas, or parentheses.
- **No `className` on raw `button`/`input`/`select`/`textarea`** inside `src/app/**` or `src/modules/**` (`no-restricted-syntax`). Use the `@/platform/ui/*` primitives, or add `// eslint-disable-next-line no-restricted-syntax` with a one-line reason.
- **Join classes with `cx`** from `@/platform/ui/cx`. There is no `tailwind-merge`, so a later class does NOT override an earlier conflicting one: never rely on class-override order.
- **Shared constants/types crossing the server -> client boundary** must live in a module WITHOUT the `"use client"` directive (a `"use client"` module's plain exports become client-reference proxies in a Server Component and throw at runtime). Only export *components* from `"use client"` files.
- Import primitives from `@/platform/ui/*`. Canonical radii: cards `rounded-2xl`, controls/buttons `rounded-lg`. `glass-panel`/`glass-bar` are chrome-only.
- **No new Prisma model and no migration.**
- **Tests:** run vitest with a per-worktree `TEST_DATABASE_URL` pointing at the local throwaway pg (`havenhub_test`, port 5434), NEVER Neon (the repo `.env` points all DB URLs, including `TEST_DATABASE_URL`, at shared Neon). CI lints before it tests. `react-hooks/purity` bans `Date.now()` in render (use `new Date()`).
- Committee score is `1-5` (`Int`, validated in code), one row per `[applicationId, scorerId]` (idempotent upsert). Permission to score: `recruitment.score` OR `recruitment.review_all`.

### Verifying tests in this worktree (run once, before Task 1)

- [ ] Confirm the local test DB is reachable and set the env var for every vitest run in this worktree:

```bash
# Adjust the URL only if your local pg differs; it MUST be the local throwaway, not Neon.
export TEST_DATABASE_URL="postgresql://haven:haven@localhost:5434/havenhub_test"
# Sanity check the existing recruitment suite is green on this branch (baseline):
TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run src/modules/recruitment/services/committee-scoring.test.ts
```
Expected: PASS. If it fails because of DB connectivity, fix that before proceeding (see memory: "Local test DB :5434", "Vitest test DB isolation"). Prepend `TEST_DATABASE_URL="$TEST_DATABASE_URL"` to every vitest command below.

---

### Task 1: Modal `size` prop (large reviewer variant)

**Files:**
- Create: `src/platform/ui/modal-size.ts`
- Create: `src/platform/ui/modal-size.test.ts`
- Modify: `src/platform/ui/modal.tsx` (add `size` prop; apply the size class via `cx`)

**Interfaces:**
- Produces: `modalSizeClass(size?: "default" | "large"): string`; `Modal` gains an optional `size?: "default" | "large"` prop (default `"default"`, backward compatible).

- [ ] **Step 1: Write the failing test**

`src/platform/ui/modal-size.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { modalSizeClass } from "./modal-size";

describe("modalSizeClass", () => {
  it("defaults to max-w-4xl", () => {
    expect(modalSizeClass()).toBe("max-w-4xl");
    expect(modalSizeClass("default")).toBe("max-w-4xl");
  });
  it("uses a wider panel for large", () => {
    expect(modalSizeClass("large")).toBe("max-w-6xl");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run src/platform/ui/modal-size.test.ts`
Expected: FAIL, cannot find module `./modal-size`.

- [ ] **Step 3: Write minimal implementation**

`src/platform/ui/modal-size.ts` (plain module, no `"use client"`, so it is safe to import from the test and from the client Modal):
```ts
export type ModalSize = "default" | "large";

/** Max-width class for the modal panel. `large` suits dense reviewer content
 *  (two-column grids plus essays); `default` keeps the original 4xl width. */
export function modalSizeClass(size: ModalSize = "default"): string {
  return size === "large" ? "max-w-6xl" : "max-w-4xl";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run src/platform/ui/modal-size.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the prop into `Modal`**

In `src/platform/ui/modal.tsx`:
1. Add the import at the top (after the existing imports):
```ts
import { cx } from "@/platform/ui/cx";
import { modalSizeClass, type ModalSize } from "@/platform/ui/modal-size";
```
2. Add `size` to `ModalProps`:
```ts
type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Accessible name for the dialog when `title` is omitted (role="dialog" must always be named). */
  ariaLabel?: string;
  /** Panel width. `large` (max-w-6xl) suits dense reviewer content. Default `default` (max-w-4xl). */
  size?: ModalSize;
  children: ReactNode;
  footer?: ReactNode;
};
```
3. Destructure it with a default:
```ts
export function Modal({ open, onClose, title, ariaLabel, size = "default", children, footer }: ModalProps) {
```
4. Replace the panel `className` (currently the string ending `max-w-4xl flex-col rounded-2xl glass-panel outline-none`) with:
```tsx
className={cx(
  "flex max-h-[90vh] w-full flex-col rounded-2xl glass-panel outline-none",
  modalSizeClass(size),
)}
```

- [ ] **Step 6: Typecheck, lint, and confirm existing Modal usage still compiles**

Run: `npx tsc --noEmit && npx eslint src/platform/ui/modal.tsx src/platform/ui/modal-size.ts`
Expected: no errors. (The one existing caller, `certificate-viewer.tsx`, omits `size`, so it stays `default`.)

- [ ] **Step 7: Commit**

```bash
git add src/platform/ui/modal-size.ts src/platform/ui/modal-size.test.ts src/platform/ui/modal.tsx
git commit -m "feat(ui): add size prop to Modal for large reviewer variant"
```

---

### Task 2: `buildSpeedScoreQueue` pure helper + shared types

**Files:**
- Create: `src/modules/recruitment/engine/speed-score-queue.ts`
- Create: `src/modules/recruitment/engine/speed-score-queue.test.ts`

**Interfaces:**
- Produces:
  - `type SpeedScoreItem = { applicationId: string; name: string; typeLabel: string; myScore: number | null }`
  - `function buildSpeedScoreQueue(items: SpeedScoreItem[], opts: { includeScored: boolean }): { queue: SpeedScoreItem[]; initialIndex: number }`
- Consumed by: Task 8 (`SpeedScoreModal`) and Task 9 (page passes `SpeedScoreItem[]`).

Semantics: `includeScored=false` -> queue is only `myScore == null` items in the given order, `initialIndex = 0`. `includeScored=true` -> queue is all items in order, `initialIndex` = first index with `myScore == null`, or `0` if none/empty. Order is preserved from the input (the page passes roster order).

- [ ] **Step 1: Write the failing test**

`src/modules/recruitment/engine/speed-score-queue.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildSpeedScoreQueue, type SpeedScoreItem } from "./speed-score-queue";

const item = (id: string, myScore: number | null): SpeedScoreItem => ({
  applicationId: id, name: id, typeLabel: "New", myScore,
});

describe("buildSpeedScoreQueue", () => {
  const items = [item("a", null), item("b", 3), item("c", null), item("d", 5)];

  it("unscored-only queue in order, starting at 0", () => {
    const { queue, initialIndex } = buildSpeedScoreQueue(items, { includeScored: false });
    expect(queue.map((q) => q.applicationId)).toEqual(["a", "c"]);
    expect(initialIndex).toBe(0);
  });

  it("include-scored keeps all in order, starting at the first unscored", () => {
    const { queue, initialIndex } = buildSpeedScoreQueue(items, { includeScored: true });
    expect(queue.map((q) => q.applicationId)).toEqual(["a", "b", "c", "d"]);
    expect(initialIndex).toBe(0);
  });

  it("include-scored starts at first unscored even when earlier items are scored", () => {
    const scoredFirst = [item("b", 3), item("a", null), item("d", 5)];
    const { initialIndex } = buildSpeedScoreQueue(scoredFirst, { includeScored: true });
    expect(initialIndex).toBe(1);
  });

  it("all scored: include-scored keeps all, index 0; unscored-only is empty, index 0", () => {
    const allScored = [item("a", 1), item("b", 2)];
    expect(buildSpeedScoreQueue(allScored, { includeScored: true })).toEqual({ queue: allScored, initialIndex: 0 });
    expect(buildSpeedScoreQueue(allScored, { includeScored: false })).toEqual({ queue: [], initialIndex: 0 });
  });

  it("empty input yields empty queue at index 0", () => {
    expect(buildSpeedScoreQueue([], { includeScored: false })).toEqual({ queue: [], initialIndex: 0 });
    expect(buildSpeedScoreQueue([], { includeScored: true })).toEqual({ queue: [], initialIndex: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run src/modules/recruitment/engine/speed-score-queue.test.ts`
Expected: FAIL, cannot find module `./speed-score-queue`.

- [ ] **Step 3: Write minimal implementation**

`src/modules/recruitment/engine/speed-score-queue.ts`:
```ts
/** One row in the speed-score queue. `myScore` is the viewer's own current
 *  score for the application (null when they have not scored it yet). */
export type SpeedScoreItem = {
  applicationId: string;
  name: string;
  typeLabel: string;
  myScore: number | null;
};

/** Build the ordered queue and the starting index for the speed-score modal.
 *  Pure and total: the caller has already filtered out the viewer's own
 *  application. Input order (roster order) is preserved. */
export function buildSpeedScoreQueue(
  items: SpeedScoreItem[],
  opts: { includeScored: boolean },
): { queue: SpeedScoreItem[]; initialIndex: number } {
  if (!opts.includeScored) {
    return { queue: items.filter((i) => i.myScore == null), initialIndex: 0 };
  }
  const firstUnscored = items.findIndex((i) => i.myScore == null);
  return { queue: items, initialIndex: firstUnscored === -1 ? 0 : firstUnscored };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run src/modules/recruitment/engine/speed-score-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/engine/speed-score-queue.ts src/modules/recruitment/engine/speed-score-queue.test.ts
git commit -m "feat(recruitment): pure speed-score queue builder"
```

---

### Task 3: Extend `listApplicantsForReview` to carry `scorerId` and `applicantPersonId`

**Files:**
- Modify: `src/modules/recruitment/services/review.ts` (the `ReviewApplication` type at lines 58-63 and the `include` in `listApplicantsForReview` at lines 77-82)
- Modify: `src/modules/recruitment/services/review.test.ts` (add one assertion; if the file does not assert on this shape yet, add a focused test)

**Interfaces:**
- Produces: `ReviewApplication.committeeScores` becomes `{ score: number; scorerId: string }[]`; `ReviewApplication.applicant` gains `applicantPersonId: string | null`. Consumed by Task 9 (page derives `myScore` and filters the viewer's own application).

Note: the roster page uses `a.committeeScores.map((c) => c.score)` and `a.applicant.firstName/lastName/email`; both keep working since the change is additive.

- [ ] **Step 1: Write the failing test**

Add to `src/modules/recruitment/services/review.test.ts` (place near the other `listApplicantsForReview` tests; reuse that file's existing fixtures/helpers for creating a cycle, an application, a scorer role, and a committee score, following the patterns already in the file). The assertion:
```ts
it("listApplicantsForReview exposes scorerId on committeeScores and applicantPersonId on applicant", async () => {
  // Arrange: a submitted application with one committee score by `scorer`.
  // (Reuse the file's existing setup helpers; see the sibling tests in this file.)
  const apps = await listApplicantsForReview(cycle.id, scorer.id);
  const target = apps.find((a) => a.id === application.id)!;
  expect(target.committeeScores[0]).toMatchObject({ score: 4, scorerId: scorer.id });
  expect(target.applicant).toHaveProperty("applicantPersonId");
});
```
(If constructing new fixtures is heavy, fold the assertion into the nearest existing test that already builds a scored application: add the two `expect` lines to it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run src/modules/recruitment/services/review.test.ts`
Expected: FAIL, `committeeScores[0]` has no `scorerId` (TypeScript error or runtime undefined).

- [ ] **Step 3: Make the change**

In `src/modules/recruitment/services/review.ts`, update the type (lines 58-63):
```ts
export type ReviewApplication = Application & {
  applicant: { firstName: string; lastName: string; email: string; applicantPersonId: string | null };
  acceptances: Acceptance[];
  committeeScores: { score: number; scorerId: string }[];
  interviews: { decision: "PENDING" | "ACCEPT" | "REJECT" | "WAITLIST" }[];
};
```
And the `include` inside `listApplicantsForReview` (lines 77-82):
```ts
    include: {
      applicant: { select: { firstName: true, lastName: true, email: true, applicantPersonId: true } },
      acceptances: true,
      committeeScores: { select: { score: true, scorerId: true } },
      interviews: { select: { decision: true } },
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run src/modules/recruitment/services/review.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the existing consumers still compile**

Run: `npx tsc --noEmit`
Expected: no errors (roster page and any other `listApplicantsForReview` caller use only fields that still exist).

- [ ] **Step 6: Commit**

```bash
git add src/modules/recruitment/services/review.ts src/modules/recruitment/services/review.test.ts
git commit -m "feat(recruitment): carry scorerId + applicantPersonId on review rows"
```

---

### Task 4: Shared inline-preview mime allowlist

**Files:**
- Create: `src/modules/recruitment/services/file-preview.ts`
- Create: `src/modules/recruitment/services/file-preview.test.ts`
- Modify: `src/app/api/recruitment/applications/[applicationId]/files/[key]/route.ts` (import the shared allowlist instead of the local `INLINE_SAFE_MIME_TYPES`)

**Interfaces:**
- Produces: `INLINE_SAFE_MIME_TYPES: ReadonlySet<string>` and `isInlinePreviewable(mimeType: string | null | undefined): boolean`. Consumed by Task 5 (view model's `inlinePreviewable`) and the file route (so the modal's inline iframe and the route's inline `Content-Disposition` can never disagree).

- [ ] **Step 1: Write the failing test**

`src/modules/recruitment/services/file-preview.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isInlinePreviewable } from "./file-preview";

describe("isInlinePreviewable", () => {
  it("allows pdf and common raster images", () => {
    for (const m of ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(isInlinePreviewable(m)).toBe(true);
    }
  });
  it("rejects svg, html, and unknown/empty types (defense against stored XSS)", () => {
    for (const m of ["image/svg+xml", "text/html", "application/octet-stream", "", null, undefined]) {
      expect(isInlinePreviewable(m)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run src/modules/recruitment/services/file-preview.test.ts`
Expected: FAIL, cannot find module `./file-preview`.

- [ ] **Step 3: Write minimal implementation**

`src/modules/recruitment/services/file-preview.ts`:
```ts
/**
 * Mime types we are willing to render inline (preview). Everything else is
 * forced to download even when inline is requested: a stored `text/html` or
 * `image/svg+xml` would be a stored-XSS vector. SVG is intentionally excluded.
 * This is the single source of truth shared by the file-serving route and the
 * speed-score view model so the reviewer's inline iframe and the route's
 * Content-Disposition can never drift.
 */
export const INLINE_SAFE_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function isInlinePreviewable(mimeType: string | null | undefined): boolean {
  return mimeType != null && INLINE_SAFE_MIME_TYPES.has(mimeType);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run src/modules/recruitment/services/file-preview.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor the route to use the shared set**

In `src/app/api/recruitment/applications/[applicationId]/files/[key]/route.ts`:
1. Add to the imports: `import { INLINE_SAFE_MIME_TYPES } from "@/modules/recruitment/services/file-preview";`
2. Delete the local `const INLINE_SAFE_MIME_TYPES = new Set([...])` block (lines ~19-25) and its doc comment.
3. Leave the usage `INLINE_SAFE_MIME_TYPES.has(file.mimeType)` unchanged (now resolves to the import).

- [ ] **Step 6: Typecheck + lint the route**

Run: `npx tsc --noEmit && npx eslint "src/app/api/recruitment/applications/[applicationId]/files/[key]/route.ts"`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/modules/recruitment/services/file-preview.ts src/modules/recruitment/services/file-preview.test.ts "src/app/api/recruitment/applications/[applicationId]/files/[key]/route.ts"
git commit -m "refactor(recruitment): share inline-preview mime allowlist"
```

---

### Task 5: `loadReviewApplication` condensed view model

**Files:**
- Create: `src/modules/recruitment/services/speed-score.ts`
- Create: `src/modules/recruitment/services/speed-score.test.ts`

**Interfaces:**
- Consumes: `getApplication` (submissions.ts), `visibleSections`/`applicantTypeLabel` (visibility.ts), `isFieldVisible` (field-visibility.ts), `reviewScope`/`canViewApplication` (review.ts), `can` (rbac engine), `isInlinePreviewable` (Task 4), `prisma` (for subcommittee names).
- Produces (all serializable; plain module, safe to import into a client component for its types):
```ts
export type ReviewFieldView = {
  key: string;
  label: string;
  kind: "scalar" | "essay" | "file";
  displayValue: string;               // resolved option label(s); "" when unanswered
  file: { key: string; fileName: string; inlineHref: string; inlinePreviewable: boolean } | null;
};
export type ReviewSectionView = { title: string; fields: ReviewFieldView[] };
export type ReviewApplicationView = {
  applicationId: string;
  name: string;
  email: string;
  typeLabel: string;                  // New | Renewal | Transfer
  departmentChoices: string[];        // codes; shown as header chips only
  sections: ReviewSectionView[];
};
export async function loadReviewApplication(
  applicationId: string, viewerId: string,
): Promise<{ view: ReviewApplicationView } | { error: string }>;
```

Behavior:
1. `getApplication(applicationId)`; if missing return `{ error: "Application not found." }`.
2. Resolve `scope = reviewScope(viewerId)`, `managesCycles = can(viewerId, "recruitment.manage_cycles")`, `canScore = can(viewerId, "recruitment.score")`; if `!canViewApplication(app, { scope, managesCycles, canScore })` return `{ error: "You can't view this application." }`.
3. `sections = visibleSections(app.cycle.sections, { applicantType: app.applicantType, selectedDepartmentCodes: app.departmentChoices })`.
4. Build `condAnswers` (a `Record<string, string | string[] | undefined>`) from `app.answers` by keeping string / string[] values and dropping objects (files) and other types, so `isFieldVisible` can evaluate `visibleWhen`.
5. Pre-resolve subcommittee names only if any visible field is `SUBCOMMITTEE_RANK`: `prisma.subcommittee.findMany({ where: { id: { in: app.subcommitteeRanking } }, select: { id: true, name: true } })` -> a `Map`.
6. For each section, for each field where `isFieldVisible(f.visibleWhen, condAnswers)`:
   - Skip `DEPARTMENT_CHOICE` entirely (department preferences render as header chips).
   - `SUBCOMMITTEE_RANK` -> scalar; `displayValue` = `app.subcommitteeRanking.map((id,i) => `${i+1}. ${names.get(id) ?? "(removed)"}`).join("  ·  ")` (empty -> "").
   - `FILE` -> kind "file"; read the answer ref `{ storedName?, fileName?, mimeType? }`; if it has `storedName`, set `file = { key: f.key, fileName: fileName ?? "(file)", inlineHref: `/api/recruitment/applications/${app.id}/files/${encodeURIComponent(f.key)}?inline=1`, inlinePreviewable: isInlinePreviewable(mimeType) }`, `displayValue = fileName ?? "(file)"`; if no storedName, `file = null`, `displayValue = ""`.
   - `LONG_TEXT` -> kind "essay"; `displayValue` = the string answer or "".
   - `SINGLE_SELECT` -> scalar; map the machine value to `f.options` label (parse `f.options` as `{value,label}[]`), fall back to the raw value.
   - `MULTI_SELECT` -> scalar; map each element to its label, join with ", ".
   - everything else (`SHORT_TEXT`, `EMAIL`, `PHONE`, `NUMBER`, `DATE`, `CHECKBOX`) -> scalar; `String(value)` (arrays joined with ", "), "" when absent.
   - Drop file fields whose `file` is null AND non-file fields whose `displayValue` is "" ONLY if you want a tighter view. For v1, KEEP empty scalars out: push a field only when it has a `displayValue` or a `file`. (Reduces "(none)" noise; matches the "condensed" goal.)
7. Drop sections that end up with zero fields.
8. Return `{ view: { applicationId: app.id, name: `${app.applicant.firstName} ${app.applicant.lastName}`, email: app.applicant.email, typeLabel: applicantTypeLabel(app.applicantType), departmentChoices: app.departmentChoices, sections } }`.

- [ ] **Step 1: Write the failing test**

`src/modules/recruitment/services/speed-score.test.ts`. Model fixture construction on `src/modules/recruitment/services/review.test.ts` / `committee-scoring.test.ts` (same `prisma` helpers). Create: a VOLUNTEER cycle; one `FormSection` (purpose APPLICATION, appliesTo BOTH) with fields: a `SINGLE_SELECT` `grad_year` with options `[{value:"2027",label:"2027"}]`, a `LONG_TEXT` `essay`, a `SINGLE_SELECT` `has_cert` options `[{value:"yes",label:"Yes"},{value:"no",label:"No"}]`, and a conditional `SHORT_TEXT` `cert_detail` with `visibleWhen = { field: "has_cert", op: "is", value: "yes" }`. An `Applicant` (+ `Application` SUBMITTED) whose `answers` set `grad_year:"2027"`, `essay:"hello world"`, `has_cert:"no"`, `cert_detail:"should be hidden"`. A `scorer` Person with a role granting `recruitment.score`. And a second cycle/app the scorer cannot see (different track, no scope) to assert access denial.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadReviewApplication } from "./speed-score";
// ...import prisma + the same helpers the sibling tests use...

describe("loadReviewApplication", () => {
  // beforeEach: build the fixture described above, capturing `application`, `scorer`, `outsider`.

  it("resolves option labels, keeps essays, and enforces access", async () => {
    const res = await loadReviewApplication(application.id, scorer.id);
    expect("view" in res).toBe(true);
    if (!("view" in res)) return;
    const fields = res.view.sections.flatMap((s) => s.fields);
    const gradYear = fields.find((f) => f.key === "grad_year")!;
    expect(gradYear.kind).toBe("scalar");
    expect(gradYear.displayValue).toBe("2027");
    const essay = fields.find((f) => f.key === "essay")!;
    expect(essay.kind).toBe("essay");
    expect(essay.displayValue).toBe("hello world");
  });

  it("drops fields hidden by visibleWhen", async () => {
    const res = await loadReviewApplication(application.id, scorer.id);
    if (!("view" in res)) throw new Error("expected view");
    const keys = res.view.sections.flatMap((s) => s.fields).map((f) => f.key);
    expect(keys).not.toContain("cert_detail"); // has_cert = "no"
  });

  it("returns an error for a viewer out of scope", async () => {
    const res = await loadReviewApplication(outsiderApplication.id, outsider.id);
    expect("error" in res).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run src/modules/recruitment/services/speed-score.test.ts`
Expected: FAIL, cannot find module `./speed-score`.

- [ ] **Step 3: Write the implementation**

`src/modules/recruitment/services/speed-score.ts`:
```ts
import { prisma } from "@/platform/db";
import { can } from "@/platform/rbac/engine";
import { getApplication } from "./submissions";
import { reviewScope, canViewApplication } from "./review";
import { visibleSections, applicantTypeLabel } from "../engine/visibility";
import { isFieldVisible } from "../engine/field-visibility";
import { isInlinePreviewable } from "./file-preview";

export type ReviewFieldView = {
  key: string;
  label: string;
  kind: "scalar" | "essay" | "file";
  displayValue: string;
  file: { key: string; fileName: string; inlineHref: string; inlinePreviewable: boolean } | null;
};
export type ReviewSectionView = { title: string; fields: ReviewFieldView[] };
export type ReviewApplicationView = {
  applicationId: string;
  name: string;
  email: string;
  typeLabel: string;
  departmentChoices: string[];
  sections: ReviewSectionView[];
};

type OptionList = { value: string; label: string }[];
function parseOptions(raw: unknown): OptionList {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is { value: string; label: string } =>
      !!o && typeof o === "object" && typeof (o as { value?: unknown }).value === "string" && typeof (o as { label?: unknown }).label === "string",
  );
}
function labelFor(options: OptionList, value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/** Build the condensed, reviewer-facing view of one application: option labels
 *  resolved, `visibleWhen`-hidden fields dropped, each field tagged with a
 *  layout `kind`. Re-checks view access (defense in depth). */
export async function loadReviewApplication(
  applicationId: string,
  viewerId: string,
): Promise<{ view: ReviewApplicationView } | { error: string }> {
  const app = await getApplication(applicationId);
  if (!app) return { error: "Application not found." };

  const [scope, managesCycles, canScore] = await Promise.all([
    reviewScope(viewerId),
    can(viewerId, "recruitment.manage_cycles"),
    can(viewerId, "recruitment.score"),
  ]);
  if (!canViewApplication(app, { scope, managesCycles, canScore })) {
    return { error: "You can't view this application." };
  }

  const answers = (app.answers ?? {}) as Record<string, unknown>;
  const condAnswers: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(answers)) {
    if (typeof v === "string") condAnswers[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) condAnswers[k] = v as string[];
  }

  const shown = visibleSections(app.cycle.sections, {
    applicantType: app.applicantType,
    selectedDepartmentCodes: app.departmentChoices,
  });

  const needsSubNames = shown.some((s) => s.fields.some((f) => f.type === "SUBCOMMITTEE_RANK"));
  const subNames = new Map<string, string>();
  if (needsSubNames && app.subcommitteeRanking.length > 0) {
    const rows = await prisma.subcommittee.findMany({
      where: { id: { in: app.subcommitteeRanking } },
      select: { id: true, name: true },
    });
    for (const r of rows) subNames.set(r.id, r.name);
  }

  const sections: ReviewSectionView[] = [];
  for (const section of shown) {
    const fields: ReviewFieldView[] = [];
    for (const f of section.fields) {
      if (f.type === "DEPARTMENT_CHOICE") continue; // shown as header chips
      if (!isFieldVisible(f.visibleWhen, condAnswers)) continue;

      if (f.type === "FILE") {
        const raw = answers[f.key];
        const ref = raw && typeof raw === "object" ? (raw as { storedName?: string; fileName?: string; mimeType?: string }) : null;
        if (!ref?.storedName) continue;
        fields.push({
          key: f.key,
          label: f.label,
          kind: "file",
          displayValue: ref.fileName ?? "(file)",
          file: {
            key: f.key,
            fileName: ref.fileName ?? "(file)",
            inlineHref: `/api/recruitment/applications/${app.id}/files/${encodeURIComponent(f.key)}?inline=1`,
            inlinePreviewable: isInlinePreviewable(ref.mimeType),
          },
        });
        continue;
      }

      let displayValue = "";
      if (f.type === "SUBCOMMITTEE_RANK") {
        displayValue = app.subcommitteeRanking.map((id, i) => `${i + 1}. ${subNames.get(id) ?? "(removed)"}`).join("  ·  ");
      } else {
        const val = answers[f.key];
        const options = parseOptions(f.options);
        if (f.type === "SINGLE_SELECT" && typeof val === "string") displayValue = labelFor(options, val);
        else if (f.type === "MULTI_SELECT" && Array.isArray(val)) displayValue = val.map((v) => labelFor(options, String(v))).join(", ");
        else if (Array.isArray(val)) displayValue = val.join(", ");
        else if (val === undefined || val === null || val === "") displayValue = "";
        else displayValue = String(val);
      }
      if (displayValue === "") continue; // condensed: skip empties

      fields.push({
        key: f.key,
        label: f.label,
        kind: f.type === "LONG_TEXT" ? "essay" : "scalar",
        displayValue,
        file: null,
      });
    }
    if (fields.length > 0) sections.push({ title: section.title, fields });
  }

  return {
    view: {
      applicationId: app.id,
      name: `${app.applicant.firstName} ${app.applicant.lastName}`,
      email: app.applicant.email,
      typeLabel: applicantTypeLabel(app.applicantType),
      departmentChoices: app.departmentChoices,
      sections,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run src/modules/recruitment/services/speed-score.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/services/speed-score.ts src/modules/recruitment/services/speed-score.test.ts
git commit -m "feat(recruitment): condensed application view model for speed scoring"
```

---

### Task 6: Server actions `speedScoreAction` + `loadReviewApplicationAction`

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts` (append two exports)

**Interfaces:**
- Produces:
  - `speedScoreAction(applicationId: string, score: number, comments: string | null): Promise<{ error?: string }>`
  - `loadReviewApplicationAction(applicationId: string): Promise<{ view: ReviewApplicationView } | { error: string }>`
- Consumed by: Task 9 (page binds and passes them to the launcher/modal).

These are thin wrappers over the tested services; unlike the existing `committeeScoreAction` they return result objects and never redirect, so the modal stays open. Their logic is covered by Task 5 (service) and Task 10 (e2e).

- [ ] **Step 1: Add the imports**

At the top of `src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts`, add:
```ts
import { loadReviewApplication, type ReviewApplicationView } from "@/modules/recruitment/services/speed-score";
```
(`requirePersonSession`, `submitCommitteeScore`, `CommitteeScoreError`, `RecruitmentAuthError` are already imported.)

- [ ] **Step 2: Append the two actions (end of file)**

```ts
/** Score an application and return a result object (no redirect): the speed-score
 *  modal stays open and advances client-side. Reuses the same validated,
 *  self-score-blocking, audited upsert as the detail-page form. */
export async function speedScoreAction(
  applicationId: string,
  score: number,
  comments: string | null,
): Promise<{ error?: string }> {
  const person = await requirePersonSession();
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return { error: "Score must be a whole number from 1 to 5." };
  }
  try {
    await submitCommitteeScore(applicationId, person.personId, score, comments && comments.trim() ? comments.trim() : null);
    return {};
  } catch (err) {
    if (err instanceof RecruitmentAuthError || err instanceof CommitteeScoreError) return { error: err.message };
    throw err;
  }
}

/** Load one applicant's condensed view model for the speed-score modal. */
export async function loadReviewApplicationAction(
  applicationId: string,
): Promise<{ view: ReviewApplicationView } | { error: string }> {
  const person = await requirePersonSession();
  return loadReviewApplication(applicationId, person.personId);
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts"`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/applicants/actions.ts"
git commit -m "feat(recruitment): speed-score + load-application server actions"
```

---

### Task 7: `DocumentPreview` client component (expand on demand)

**Files:**
- Create: `src/modules/recruitment/components/document-preview.tsx`

**Interfaces:**
- Produces: `DocumentPreview({ fileName, inlineHref, inlinePreviewable }: { fileName: string; inlineHref: string; inlinePreviewable: boolean })` (default export not used; named export). A toggle button that expands an inline iframe (when `inlinePreviewable`) or, otherwise, shows "Open in new tab". Mounts the iframe only while expanded (mirrors `CertificateViewer`).
- Consumed by: Task 8 (`SpeedScoreModal` Documents zone).

- [ ] **Step 1: Write the component**

`src/modules/recruitment/components/document-preview.tsx`:
```tsx
"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button, buttonClasses } from "@/platform/ui/button";

/** A single uploaded file rendered as an expand-on-demand preview. The iframe is
 *  mounted only while expanded, so a card with several documents does not load
 *  them all at once. Non-inline-previewable types (per the shared allowlist)
 *  offer "Open in new tab" instead of an iframe. */
export function DocumentPreview({
  fileName,
  inlineHref,
  inlinePreviewable,
}: {
  fileName: string;
  inlineHref: string;
  inlinePreviewable: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span className="truncate">{fileName}</span>
        </Button>
        <a href={inlineHref} target="_blank" rel="noopener noreferrer" className={buttonClasses("ghost", "sm")}>
          Open in new tab
        </a>
      </div>
      {open && inlinePreviewable && (
        <iframe
          src={inlineHref}
          title={`Document preview: ${fileName}`}
          className="h-[60vh] w-full rounded-b-lg border-t border-border"
        />
      )}
      {open && !inlinePreviewable && (
        <p className="px-3 pb-3 text-sm text-muted-foreground">
          This file type can't be previewed inline. Use "Open in new tab" to view it.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint src/modules/recruitment/components/document-preview.tsx`
Expected: no errors. (Verify `lucide-react` exports `ChevronDown`/`ChevronRight`; both are standard. If a raw-element lint fires, it should not: no raw `button`/`input` is used, only the `Button` primitive and an `<a>`.)

- [ ] **Step 3: Commit**

```bash
git add src/modules/recruitment/components/document-preview.tsx
git commit -m "feat(recruitment): expand-on-demand document preview"
```

---

### Task 8: `SpeedScoreModal` client component

**Files:**
- Create: `src/modules/recruitment/components/speed-score-modal.tsx`

**Interfaces:**
- Consumes: `Modal` (with `size="large"`), `Button`, `Badge`, `Alert`, `Spinner` from `@/platform/ui/*`; `buildSpeedScoreQueue` + `SpeedScoreItem` (Task 2); `ReviewApplicationView` (Task 5); `DocumentPreview` (Task 7).
- Produces: `SpeedScoreModal({ open, onClose, items, onScore, onLoad }: SpeedScoreModalProps)` where:
```ts
type SpeedScoreModalProps = {
  open: boolean;
  onClose: () => void;
  items: SpeedScoreItem[];                                     // roster order, viewer's own app already removed
  onScore: (applicationId: string, score: number, comments: string | null) => Promise<{ error?: string }>;
  onLoad: (applicationId: string) => Promise<{ view: ReviewApplicationView } | { error: string }>;
};
```
- Consumed by: Task 9 (`SpeedScoreLauncher`).

Behavior contract (implemented below):
- The queue is computed from the OPENING snapshot of `items` (so scoring an item does not reshuffle indices). Toggling "show scored" recomputes from the snapshot and tries to keep the current applicant in view.
- `1`-`5`: score current + advance to next queue index. `Left`/`Right`: move without scoring. Number/arrow keys are ignored while a form control is focused (the comment field) and while a save is in flight and on the done screen.
- Views are cached by `applicationId` (a plain object in state); the current applicant shows a `Spinner` until its view arrives; the next item is prefetched.
- Reaching the end shows a done summary.

- [ ] **Step 1: Write the component**

`src/modules/recruitment/components/speed-score-modal.tsx`:
```tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Modal } from "@/platform/ui/modal";
import { Button } from "@/platform/ui/button";
import { Badge } from "@/platform/ui/badge";
import { Alert } from "@/platform/ui/alert";
import { Spinner } from "@/platform/ui/spinner";
import { Input } from "@/platform/ui/input";
import { Checkbox } from "@/platform/ui/checkbox";
import { buildSpeedScoreQueue, type SpeedScoreItem } from "@/modules/recruitment/engine/speed-score-queue";
import type { ReviewApplicationView } from "@/modules/recruitment/services/speed-score";
import { DocumentPreview } from "./document-preview";

type SpeedScoreModalProps = {
  open: boolean;
  onClose: () => void;
  items: SpeedScoreItem[];
  onScore: (applicationId: string, score: number, comments: string | null) => Promise<{ error?: string }>;
  onLoad: (applicationId: string) => Promise<{ view: ReviewApplicationView } | { error: string }>;
};

export function SpeedScoreModal({ open, onClose, items, onScore, onLoad }: SpeedScoreModalProps) {
  // Opening snapshot: freeze the item set so live scoring never reindexes the queue.
  const snapshot = useRef<SpeedScoreItem[]>(items);
  const [includeScored, setIncludeScored] = useState(false);
  const [index, setIndex] = useState(0);
  const [liveScores, setLiveScores] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(items.map((i) => [i.applicationId, i.myScore])),
  );
  const [views, setViews] = useState<Record<string, ReviewApplicationView>>({});
  const [viewError, setViewError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();

  const { queue, initialIndex } = useMemo(
    () => buildSpeedScoreQueue(snapshot.current, { includeScored }),
    [includeScored],
  );

  // Reset position when the queue basis changes (open, or toggle).
  useEffect(() => {
    setIndex(initialIndex);
  }, [initialIndex]);

  const total = snapshot.current.length;
  const scoredCount = Object.values(liveScores).filter((v) => v != null).length;
  const current = index < queue.length ? queue[index] : null;
  const done = current == null;
  const currentView = current ? views[current.applicationId] : undefined;

  const ensureLoaded = useCallback(
    async (applicationId: string, isCurrent: boolean) => {
      // Read latest views via functional update to avoid a stale closure.
      let alreadyHave = false;
      setViews((prev) => {
        alreadyHave = Boolean(prev[applicationId]);
        return prev;
      });
      if (alreadyHave) return;
      const res = await onLoad(applicationId);
      if ("view" in res) {
        setViews((prev) => ({ ...prev, [applicationId]: res.view }));
      } else if (isCurrent) {
        setViewError(res.error);
      }
    },
    [onLoad],
  );

  // Load current + prefetch next whenever the position changes.
  useEffect(() => {
    if (!open || !current) return;
    setViewError(null);
    setComment("");
    void ensureLoaded(current.applicationId, true);
    const next = queue[index + 1];
    if (next) void ensureLoaded(next.applicationId, false);
  }, [open, current, queue, index, ensureLoaded]);

  const goTo = useCallback(
    (nextIndex: number) => {
      setIndex((i) => Math.min(Math.max(0, nextIndex), queue.length));
    },
    [queue.length],
  );

  const handleScore = useCallback(
    (value: number) => {
      if (!current || isSaving) return;
      const target = current.applicationId;
      const note = comment.trim() ? comment.trim() : null;
      setSaveError(null);
      startSave(async () => {
        const res = await onScore(target, value, note);
        if (res?.error) {
          setSaveError(res.error);
          return;
        }
        setLiveScores((prev) => ({ ...prev, [target]: value }));
        setIndex((i) => i + 1);
      });
    },
    [current, isSaving, comment, onScore],
  );

  // Global keyboard: 1-5 scores + advances; arrows navigate. Suppressed while a
  // form control is focused (comment field), while saving, and on the done screen.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (done || isSaving) return;
      if (e.key >= "1" && e.key <= "5") {
        e.preventDefault();
        handleScore(Number(e.key));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goTo(index + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goTo(index - 1);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, done, isSaving, index, handleScore, goTo]);

  const currentScore = current ? liveScores[current.applicationId] ?? null : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="large"
      title={
        done
          ? "Speed score"
          : current
            ? `${current.name}  (${index + 1} of ${queue.length})`
            : "Speed score"
      }
      footer={
        done ? (
          <Button type="button" variant="primary" size="sm" onClick={onClose}>Close</Button>
        ) : (
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <Button
                  key={n}
                  type="button"
                  size="sm"
                  variant={currentScore === n ? "primary" : "outline"}
                  disabled={isSaving}
                  onClick={() => handleScore(n)}
                  aria-label={`Score ${n}`}
                >
                  {n}
                </Button>
              ))}
              {isSaving && <Spinner size="sm" className="ml-1 text-muted-foreground" />}
            </div>
            <div className="w-64 max-w-full">
              <Input
                placeholder="Comment (optional)"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                aria-label="Comment (optional)"
              />
            </div>
          </div>
        )
      }
    >
      {done ? (
        <div className="space-y-3 py-6 text-center">
          <p className="text-lg font-semibold text-foreground">All caught up.</p>
          <p className="text-sm text-muted-foreground">You've scored {scoredCount} of {total} applicants.</p>
          {!includeScored && scoredCount < total && (
            <Button type="button" variant="outline" size="sm" onClick={() => setIncludeScored(true)}>
              Review scored applicants
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge>{current!.typeLabel}</Badge>
            <span className="text-muted-foreground">{currentView?.email}</span>
            {currentView && currentView.departmentChoices.length > 0 && (
              <span className="text-muted-foreground">Prefs: {currentView.departmentChoices.join(", ")}</span>
            )}
            <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox checked={includeScored} onChange={(e) => setIncludeScored(e.target.checked)} />
              Show scored
            </label>
          </div>

          {saveError && <Alert tone="error">{saveError}</Alert>}
          {viewError && <Alert tone="error">{viewError}</Alert>}

          {!currentView && !viewError && (
            <div className="flex items-center justify-center py-16"><Spinner size="lg" /></div>
          )}

          {currentView && <ApplicationBody view={currentView} />}

          <p className="text-xs text-subtle-foreground">
            Press 1-5 to score and advance. Left/Right to move. Esc to close.
          </p>
        </div>
      )}
    </Modal>
  );
}

/** Renders the condensed application: scalars in a dense grid, essays full-width,
 *  files as expand-on-demand previews. Fields are flattened across sections and
 *  bucketed by `kind` (matches the approved mockup). */
function ApplicationBody({ view }: { view: ReviewApplicationView }) {
  const all = view.sections.flatMap((s) => s.fields.map((f) => ({ ...f, section: s.title })));
  const scalars = all.filter((f) => f.kind === "scalar");
  const essays = all.filter((f) => f.kind === "essay");
  const files = all.filter((f) => f.kind === "file" && f.file);

  return (
    <div className="space-y-5">
      {scalars.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle-foreground">At a glance</h3>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {scalars.map((f) => (
              <div key={f.key}>
                <dt className="text-xs text-subtle-foreground">{f.label}</dt>
                <dd className="mt-0.5 text-sm text-foreground">{f.displayValue}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {essays.length > 0 && (
        <section className="space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle-foreground">Essays</h3>
          {essays.map((f) => (
            <div key={f.key}>
              <h4 className="text-sm font-medium text-foreground">{f.label}</h4>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground-soft">{f.displayValue}</p>
            </div>
          ))}
        </section>
      )}
      {files.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle-foreground">Documents</h3>
          {files.map((f) => (
            <DocumentPreview
              key={f.key}
              fileName={f.file!.fileName}
              inlineHref={f.file!.inlineHref}
              inlinePreviewable={f.file!.inlinePreviewable}
            />
          ))}
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint src/modules/recruitment/components/speed-score-modal.tsx`
Expected: no errors. Everything uses primitives (`Checkbox` for the toggle, `Input` for the comment, `Button` for the score keys). Confirm `Spinner` accepts a `className` prop (it does) and `Input` forwards `value`/`onChange`/`placeholder` (it wraps the native input).

- [ ] **Step 3: Commit**

```bash
git add src/modules/recruitment/components/speed-score-modal.tsx
git commit -m "feat(recruitment): keyboard-driven speed-score modal"
```

---

### Task 9: `SpeedScoreLauncher` + wire into the applicant list page

**Files:**
- Create: `src/modules/recruitment/components/speed-score-launcher.tsx`
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx`

**Interfaces:**
- Consumes: `SpeedScoreModal` (Task 8), `SpeedScoreItem` (Task 2), `Button`, the bound server actions `speedScoreAction`/`loadReviewApplicationAction` (Task 6).
- Produces: `SpeedScoreLauncher({ items, onScore, onLoad }: { items: SpeedScoreItem[]; onScore: ...; onLoad: ... })` (same action prop types as `SpeedScoreModal`). A `Button` that opens the modal.

- [ ] **Step 1: Write the launcher**

`src/modules/recruitment/components/speed-score-launcher.tsx`:
```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Zap } from "lucide-react";
import { Button } from "@/platform/ui/button";
import type { SpeedScoreItem } from "@/modules/recruitment/engine/speed-score-queue";
import type { ReviewApplicationView } from "@/modules/recruitment/services/speed-score";
import { SpeedScoreModal } from "./speed-score-modal";

export function SpeedScoreLauncher({
  items,
  onScore,
  onLoad,
}: {
  items: SpeedScoreItem[];
  onScore: (applicationId: string, score: number, comments: string | null) => Promise<{ error?: string }>;
  onLoad: (applicationId: string) => Promise<{ view: ReviewApplicationView } | { error: string }>;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const unscored = items.filter((i) => i.myScore == null).length;
  // speedScoreAction intentionally does not revalidate (so the modal stays open
  // and advances). Refresh on close so the roster's committee averages reflect
  // the scores just entered, and a reopen starts from fresh server data.
  function close() {
    setOpen(false);
    router.refresh();
  }
  return (
    <>
      <Button type="button" variant="primary" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Zap className="h-4 w-4" />
        Speed score{unscored > 0 ? ` (${unscored})` : ""}
      </Button>
      {open && (
        <SpeedScoreModal
          open={open}
          onClose={close}
          items={items}
          onScore={onScore}
          onLoad={onLoad}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Wire the page**

In `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx`:
1. Add imports:
```ts
import { can } from "@/platform/rbac/engine";
import { reviewScope } from "@/modules/recruitment/services/review";
import { SpeedScoreLauncher } from "@/modules/recruitment/components/speed-score-launcher";
import { speedScoreAction, loadReviewApplicationAction } from "./actions";
import type { SpeedScoreItem } from "@/modules/recruitment/engine/speed-score-queue";
```
2. After `const apps = await listApplicantsForReview(id, person.personId);` (line 31), compute `canScore` and the queue:
```ts
  const [scope, canScorePerm] = await Promise.all([
    reviewScope(person.personId),
    can(person.personId, "recruitment.score"),
  ]);
  const canScore = scope.all || canScorePerm;
  const speedItems: SpeedScoreItem[] = canScore
    ? apps
        .filter((a) => a.applicant.applicantPersonId !== person.personId) // never queue your own application
        .map((a) => ({
          applicationId: a.id,
          name: `${a.applicant.firstName} ${a.applicant.lastName}`,
          typeLabel: applicantTypeLabel(a.applicantType),
          myScore: a.committeeScores.find((c) => c.scorerId === person.personId)?.score ?? null,
        }))
    : [];
```
3. Render the launcher in the header row. Replace the `<PageHeader ... />` line (line 44) with a header row that keeps the title and adds the button on the right:
```tsx
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title="Applicants" description={cycle.title} />
        {canScore && speedItems.length > 0 && (
          <SpeedScoreLauncher
            items={speedItems}
            onScore={speedScoreAction}
            onLoad={loadReviewApplicationAction}
          />
        )}
      </div>
```
(`applicantTypeLabel` is already imported on line 12.)

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx" src/modules/recruitment/components/speed-score-launcher.tsx`
Expected: no errors. (`Zap` is a valid `lucide-react` icon.)

- [ ] **Step 4: Manual smoke test**

Start the dev server and confirm the button opens the modal, 1-5 advances, Esc closes. Use the local dev DB, not Neon.
```bash
npm run dev
```
Then in a browser as a user holding `recruitment.score`, open a cycle's Applicants page, click "Speed score", read a card, press 1-5, and confirm it advances and the "Committee avg" on the roster reflects the score after closing. Stop the dev server when done.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/components/speed-score-launcher.tsx "src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx"
git commit -m "feat(recruitment): speed-score launcher on the applicant list"
```

---

### Task 10: Playwright e2e for the speed-score flow

**Files:**
- Create: an e2e spec next to the existing recruitment specs.

**First, orient (do this before writing):**
```bash
ls e2e 2>/dev/null || ls tests/e2e 2>/dev/null || find . -maxdepth 3 -name "*.spec.ts" -path "*recruit*" -not -path "*/node_modules/*"
```
Open the closest existing recruitment spec (e.g. a "recruitment apply" spec) and reuse ITS fixtures/helpers: how it seeds a cycle + a submitted application, how it logs in a reviewer with `recruitment.score`, and the base URL. Match that file's imports, `test.describe`, and login helper exactly. The intent below is fixed; adapt the seams to the repo's fixtures.

**Interfaces:**
- Consumes: the full wired feature (Tasks 1-9).

- [ ] **Step 1: Write the failing e2e**

Create `e2e/recruitment-speed-scoring.spec.ts` (or the directory the orientation step revealed), following the sibling spec's structure. Core assertions:
```ts
import { test, expect } from "@playwright/test";
// ...reuse the sibling recruitment spec's fixture + login helpers...

test.describe("recruitment speed score", () => {
  test("score an applicant with the keyboard and advance", async ({ page }) => {
    // Arrange (via the shared fixtures): a cycle with >= 2 SUBMITTED applications
    // and a signed-in reviewer holding recruitment.score. Navigate to:
    //   /recruitment/cycles/{cycleId}/applicants
    await page.goto(`/recruitment/cycles/${cycleId}/applicants`);

    // Open the modal.
    await page.getByRole("button", { name: /speed score/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The first applicant's condensed view is shown (At a glance heading).
    await expect(dialog.getByText(/at a glance/i)).toBeVisible();

    // Press 3 to score and advance.
    await page.keyboard.press("3");

    // It advances: the "N of M" counter moves, or the done screen appears if only
    // one unscored applicant existed. Assert the modal is still usable and no error.
    await expect(dialog.getByText(/you can't/i)).toHaveCount(0);

    // Close and confirm the roster reflects the score (Committee avg no longer "-").
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // The scored applicant's row now shows an average like "3.0 · 1".
    await expect(page.getByText(/3\.0 · 1/)).toBeVisible();
  });
});
```

- [ ] **Step 2: Run it and watch it drive the real feature**

Run the single spec (use the project's e2e runner; match how the sibling spec is run, e.g.):
```bash
npx playwright test e2e/recruitment-speed-scoring.spec.ts
```
Expected: PASS. If the roster-average assertion is brittle against the fixture's data, assert instead that the modal advanced (the "1 of N" -> "2 of N" counter changed, or the done panel "All caught up." is visible). Keep the keyboard-driven score + advance as the core assertion.

- [ ] **Step 3: Commit**

```bash
git add e2e/recruitment-speed-scoring.spec.ts
git commit -m "test(e2e): keyboard speed-score flow"
```

---

## Final verification (after all tasks)

- [ ] Full typecheck + lint: `npx tsc --noEmit && npm run lint`
- [ ] Targeted vitest: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx vitest run src/platform/ui/modal-size.test.ts src/modules/recruitment/engine/speed-score-queue.test.ts src/modules/recruitment/services/file-preview.test.ts src/modules/recruitment/services/speed-score.test.ts src/modules/recruitment/services/review.test.ts`
- [ ] The e2e spec passes (Task 10).
- [ ] Manual: as a `recruitment.score` holder, speed-score through a cycle end to end, including "Show scored", a document expand, and the done screen.

## Spec coverage self-check (author, pre-handoff)

- Launch point (list-page button): Task 9. ✅
- Queue: start unscored, skip scored, "show scored" toggle, done summary: Task 2 (pure) + Task 8 (modal). ✅
- Comments optional/non-blocking: Task 8 (comment `Input`, sent with score). ✅
- Documents expand-on-demand: Task 7 + Task 8 Documents zone. ✅
- Data loading approach B (lazy + prefetch-next): Task 8 (`ensureLoaded` current + next). ✅
- Type-based "at a glance" zoning: Task 5 (kind) + Task 8 (`ApplicationBody`). ✅
- Modal large variant: Task 1. ✅
- Permissions/self-score/access: Task 3 (data), Task 5 (view access), Task 6 (score action), Task 9 (gate + self-filter). ✅
- Fix detail-page gaps (visibleWhen hidden fields, option labels): Task 5. ✅
- Tests (unit queue, service view model, e2e): Tasks 2, 5, 10 (+ 1, 4). ✅
