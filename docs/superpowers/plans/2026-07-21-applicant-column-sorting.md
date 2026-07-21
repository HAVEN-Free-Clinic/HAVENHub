# Applicant Roster Column Sorting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let reviewers sort the applicant roster by any of its seven columns, with the sort state held in the URL.

**Architecture:** The roster page already loads every applicant into memory, filters by decision, then slices for pagination. Sorting slots in as one more in-memory step between the filter and the slice. Sort state travels as `?sort=<key>&dir=asc|desc`, and column headers are `next/link` links, so the page stays a server component with no client JavaScript.

**Tech Stack:** Next.js App Router (server components), TypeScript, Vitest, Tailwind, lucide-react.

**Spec:** `docs/superpowers/specs/2026-07-21-applicant-column-sorting-design.md`

## Global Constraints

- **No em-dashes** in any code comment, string, or doc prose. Use commas, colons, semicolons, or parentheses.
- **Soft navigation only.** Internal links use `next/link` `Link`, never a bare `<a href>`. A bare anchor triggers a full page reload.
- **The roster page stays a server component.** Do not add `"use client"` to `applicants/page.tsx`.
- **Tests are colocated** next to the module as `<name>.test.ts`, using `import { expect, it } from "vitest";` with flat `it(...)` blocks and no `describe` wrapper.
- **Classnames use `cx` from `@/platform/ui/cx`.** There is no `tailwind-merge` in this repo.
- **Run tests with** `npx vitest run <path>` from the worktree root.
- Existing `TH` behaviour must not change. Every other table in the app renders through it.

---

### Task 1: Ordered stage and decision arrays

Sorting by Stage and Decision must follow pipeline and precedence order, not alphabetical order. Both orderings currently exist only as the declaration order of a union type, which is not something code can read. This task promotes them to exported arrays.

**Files:**
- Modify: `src/modules/recruitment/engine/application-stage.ts`
- Modify: `src/modules/recruitment/engine/decision-summary.ts`
- Test: `src/modules/recruitment/engine/application-stage.test.ts` (existing, append)
- Test: `src/modules/recruitment/engine/decision-summary.test.ts` (existing, append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `APPLICATION_STAGE_ORDER: readonly ApplicationStage[]` from `./application-stage`
  - `ROSTER_DECISION_ORDER: readonly RosterDecisionStatus[]` from `./decision-summary`

- [ ] **Step 1: Write the failing tests**

In `src/modules/recruitment/engine/application-stage.test.ts`, replace the existing second line:

```ts
import { applicationStage } from "./application-stage";
```

with:

```ts
import { APPLICATION_STAGE_ORDER, applicationStage, applicationStageLabel } from "./application-stage";
```

Then append these tests to the end of that file:

```ts
it("orders stages along the recruitment pipeline", () => {
  expect(APPLICATION_STAGE_ORDER).toEqual([
    "AWAITING_SCORING",
    "SCORING",
    "ROUTED",
    "INTERVIEWING",
    "DECIDED",
  ]);
});

it("orders every stage that has a label", () => {
  // Drift guard: adding a stage without placing it in the order array would
  // silently drop it to the front of a stage-sorted roster.
  expect([...APPLICATION_STAGE_ORDER].sort()).toEqual(Object.keys(applicationStageLabel).sort());
});
```

In `src/modules/recruitment/engine/decision-summary.test.ts`, replace the existing second line:

```ts
import { rosterDecision } from "./decision-summary";
```

with:

```ts
import { ROSTER_DECISION_ORDER, rosterDecision } from "./decision-summary";
```

Then append this test to the end of that file:

```ts
it("orders decisions by precedence, strongest outcome first", () => {
  // Matches the precedence the rosterDecision if-chain already implements.
  expect(ROSTER_DECISION_ORDER).toEqual(["ACCEPTED", "WAITLIST", "REJECTED", "NONE"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/modules/recruitment/engine/application-stage.test.ts src/modules/recruitment/engine/decision-summary.test.ts
```

Expected: FAIL. The new tests error on the undefined imports `APPLICATION_STAGE_ORDER` and `ROSTER_DECISION_ORDER`. Pre-existing tests in both files still pass.

- [ ] **Step 3: Add the order arrays**

Append to `src/modules/recruitment/engine/application-stage.ts`:

```ts
/** Pipeline order, used to sort the roster by stage. The index is the stage's
 *  position in the recruitment process, so a stage-sorted roster groups the way
 *  the process actually runs rather than alphabetically. */
export const APPLICATION_STAGE_ORDER: readonly ApplicationStage[] = [
  "AWAITING_SCORING",
  "SCORING",
  "ROUTED",
  "INTERVIEWING",
  "DECIDED",
];
```

Append to `src/modules/recruitment/engine/decision-summary.ts`:

```ts
/** Precedence order, used to sort the roster by decision. Mirrors the if-chain
 *  in rosterDecision: accepted > waitlisted > rejected > none. */
export const ROSTER_DECISION_ORDER: readonly RosterDecisionStatus[] = [
  "ACCEPTED",
  "WAITLIST",
  "REJECTED",
  "NONE",
];
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/modules/recruitment/engine/application-stage.test.ts src/modules/recruitment/engine/decision-summary.test.ts
```

Expected: PASS, all tests in both files.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/engine/application-stage.ts src/modules/recruitment/engine/application-stage.test.ts src/modules/recruitment/engine/decision-summary.ts src/modules/recruitment/engine/decision-summary.test.ts
git commit -m "feat(recruitment): export pipeline and precedence order arrays for roster sorting"
```

---

### Task 2: The applicant sort comparator

The pure core of the feature. No React, no Prisma imports. Everything the reviewer clicks resolves to a call into this module.

**Files:**
- Create: `src/modules/recruitment/engine/applicant-sort.ts`
- Test: `src/modules/recruitment/engine/applicant-sort.test.ts`

**Interfaces:**
- Consumes: `APPLICATION_STAGE_ORDER` and `ROSTER_DECISION_ORDER` from Task 1. Also the existing `scoreAverage` (`./scoring`), `applicantTypeLabel` and `ApplicantType` (`./visibility`), `applicationStage` (`./application-stage`), `rosterDecision` and `Decision` (`./decision-summary`).
- Produces, all from `@/modules/recruitment/engine/applicant-sort`:
  - `type ApplicantSortKey = "name" | "email" | "type" | "score" | "stage" | "ranked" | "decision"`
  - `type SortDirection = "asc" | "desc"`
  - `type ApplicantSort = { key: ApplicantSortKey; dir: SortDirection }`
  - `type SortableApplicant` (structural input shape)
  - `APPLICANT_SORT_KEYS: readonly ApplicantSortKey[]`
  - `DEFAULT_SORT_DIRECTION: Record<ApplicantSortKey, SortDirection>`
  - `parseApplicantSort(sort: string | undefined, dir: string | undefined): ApplicantSort | null`
  - `nextSortDirection(current: ApplicantSort | null, key: ApplicantSortKey): SortDirection`
  - `sortApplicants<T extends SortableApplicant>(apps: T[], sort: ApplicantSort): T[]`

- [ ] **Step 1: Write the failing test**

Create `src/modules/recruitment/engine/applicant-sort.test.ts`:

```ts
import { expect, it } from "vitest";
import {
  DEFAULT_SORT_DIRECTION,
  nextSortDirection,
  parseApplicantSort,
  sortApplicants,
  type SortableApplicant,
} from "./applicant-sort";

const base: SortableApplicant = {
  applicant: { firstName: "Ada", lastName: "Lovelace", email: "ada.lovelace@yale.edu" },
  applicantType: "NEW",
  committeeScores: [],
  routedDepartmentCode: null,
  decision: "PENDING",
  interviews: [],
  acceptances: [],
  departmentChoices: [],
};

function app(overrides: Partial<SortableApplicant>): SortableApplicant {
  return { ...base, ...overrides };
}

/** An applicant identified only by last name, for name-ordering assertions. */
function named(lastName: string): SortableApplicant {
  return app({ applicant: { firstName: "Sam", lastName, email: "sam@yale.edu" } });
}

const lastNames = (apps: SortableApplicant[]) => apps.map((a) => a.applicant.lastName);

it("sorts by last name ascending, then descending", () => {
  const apps = [named("Tracey"), named("Alvarez"), named("Mensah")];
  expect(lastNames(sortApplicants(apps, { key: "name", dir: "asc" }))).toEqual(["Alvarez", "Mensah", "Tracey"]);
  expect(lastNames(sortApplicants(apps, { key: "name", dir: "desc" }))).toEqual(["Tracey", "Mensah", "Alvarez"]);
});

it("breaks a shared last name on first name", () => {
  const a = app({ applicant: { firstName: "Zoe", lastName: "Chen", email: "z@yale.edu" } });
  const b = app({ applicant: { firstName: "Alex", lastName: "Chen", email: "a@yale.edu" } });
  const sorted = sortApplicants([a, b], { key: "name", dir: "asc" });
  expect(sorted.map((s) => s.applicant.firstName)).toEqual(["Alex", "Zoe"]);
});

it("sorts accented names next to their unaccented neighbours", () => {
  // A naive `<` compare puts "Renee" after "Zamora", because U+00E9 > "Z".
  const apps = [named("Zamora"), named("Renée"), named("Reed")];
  expect(lastNames(sortApplicants(apps, { key: "name", dir: "asc" }))).toEqual(["Reed", "Renée", "Zamora"]);
});

it("sorts by email", () => {
  const a = app({ applicant: { firstName: "A", lastName: "A", email: "zoe@yale.edu" } });
  const b = app({ applicant: { firstName: "B", lastName: "B", email: "abe@yale.edu" } });
  const sorted = sortApplicants([a, b], { key: "email", dir: "asc" });
  expect(sorted.map((s) => s.applicant.email)).toEqual(["abe@yale.edu", "zoe@yale.edu"]);
});

it("sorts by applicant type label", () => {
  const apps = [app({ applicantType: "RENEWAL" }), app({ applicantType: "NEW" }), app({ applicantType: "TRANSFER" })];
  const sorted = sortApplicants(apps, { key: "type", dir: "asc" });
  // Labels are New, Renewal, Transfer.
  expect(sorted.map((s) => s.applicantType)).toEqual(["NEW", "RENEWAL", "TRANSFER"]);
});

it("sorts by committee average", () => {
  const apps = [
    app({ applicant: { firstName: "A", lastName: "Low", email: "l@yale.edu" }, committeeScores: [{ score: 2 }] }),
    app({ applicant: { firstName: "B", lastName: "High", email: "h@yale.edu" }, committeeScores: [{ score: 5 }] }),
    app({ applicant: { firstName: "C", lastName: "Mid", email: "m@yale.edu" }, committeeScores: [{ score: 3 }, { score: 4 }] }),
  ];
  expect(lastNames(sortApplicants(apps, { key: "score", dir: "desc" }))).toEqual(["High", "Mid", "Low"]);
  expect(lastNames(sortApplicants(apps, { key: "score", dir: "asc" }))).toEqual(["Low", "Mid", "High"]);
});

it("sinks unscored applicants to the bottom in BOTH directions", () => {
  const apps = [
    app({ applicant: { firstName: "A", lastName: "Unscored", email: "u@yale.edu" }, committeeScores: [] }),
    app({ applicant: { firstName: "B", lastName: "Low", email: "l@yale.edu" }, committeeScores: [{ score: 1 }] }),
    app({ applicant: { firstName: "C", lastName: "High", email: "h@yale.edu" }, committeeScores: [{ score: 5 }] }),
  ];
  // Ascending must surface the genuinely low scorer, not a screenful of blanks.
  expect(lastNames(sortApplicants(apps, { key: "score", dir: "asc" }))).toEqual(["Low", "High", "Unscored"]);
  expect(lastNames(sortApplicants(apps, { key: "score", dir: "desc" }))).toEqual(["High", "Low", "Unscored"]);
});

it("sorts by stage in pipeline order, not alphabetically", () => {
  const awaiting = app({ applicant: { firstName: "A", lastName: "Awaiting", email: "a@yale.edu" } });
  const scoring = app({
    applicant: { firstName: "B", lastName: "Scoring", email: "s@yale.edu" },
    committeeScores: [{ score: 4 }],
  });
  const routed = app({
    applicant: { firstName: "C", lastName: "Routed", email: "r@yale.edu" },
    committeeScores: [{ score: 4 }],
    routedDepartmentCode: "EDUC",
  });
  const decided = app({ applicant: { firstName: "D", lastName: "Decided", email: "d@yale.edu" }, decision: "ACCEPT" });
  const sorted = sortApplicants([decided, routed, awaiting, scoring], { key: "stage", dir: "asc" });
  expect(lastNames(sorted)).toEqual(["Awaiting", "Scoring", "Routed", "Decided"]);
});

it("sorts by decision in precedence order, not alphabetically", () => {
  const accepted = app({
    applicant: { firstName: "A", lastName: "Accepted", email: "a@yale.edu" },
    acceptances: [{ departmentCode: "EDUC" }],
  });
  const waitlisted = app({ applicant: { firstName: "W", lastName: "Waitlisted", email: "w@yale.edu" }, decision: "WAITLIST" });
  const rejected = app({ applicant: { firstName: "R", lastName: "Rejected", email: "r@yale.edu" }, decision: "REJECT" });
  const none = app({ applicant: { firstName: "N", lastName: "None", email: "n@yale.edu" } });
  const sorted = sortApplicants([none, rejected, accepted, waitlisted], { key: "decision", dir: "asc" });
  expect(lastNames(sorted)).toEqual(["Accepted", "Waitlisted", "Rejected", "None"]);
});

it("sorts by ranked department choices", () => {
  const apps = [
    app({ applicant: { firstName: "A", lastName: "Second", email: "s@yale.edu" }, departmentChoices: ["MDIC"] }),
    app({ applicant: { firstName: "B", lastName: "First", email: "f@yale.edu" }, departmentChoices: ["CRAD", "EDUC"] }),
  ];
  expect(lastNames(sortApplicants(apps, { key: "ranked", dir: "asc" }))).toEqual(["First", "Second"]);
});

it("keeps the incoming order for ties, preserving submission recency", () => {
  const newest = app({ applicant: { firstName: "A", lastName: "Newest", email: "n@yale.edu" }, committeeScores: [{ score: 4 }] });
  const older = app({ applicant: { firstName: "B", lastName: "Older", email: "o@yale.edu" }, committeeScores: [{ score: 4 }] });
  const oldest = app({ applicant: { firstName: "C", lastName: "Oldest", email: "x@yale.edu" }, committeeScores: [{ score: 4 }] });
  // Input arrives from the service already ordered submittedAt desc.
  const sorted = sortApplicants([newest, older, oldest], { key: "score", dir: "desc" });
  expect(lastNames(sorted)).toEqual(["Newest", "Older", "Oldest"]);
});

it("does not mutate the input array", () => {
  const apps = [named("Tracey"), named("Alvarez")];
  sortApplicants(apps, { key: "name", dir: "asc" });
  expect(lastNames(apps)).toEqual(["Tracey", "Alvarez"]);
});

it("parses a valid sort and direction", () => {
  expect(parseApplicantSort("score", "desc")).toEqual({ key: "score", dir: "desc" });
  expect(parseApplicantSort("name", "asc")).toEqual({ key: "name", dir: "asc" });
});

it("falls back to the default order for an unknown key or direction", () => {
  expect(parseApplicantSort("nickname", "asc")).toBeNull();
  expect(parseApplicantSort("score", "sideways")).toBeNull();
  expect(parseApplicantSort(undefined, undefined)).toBeNull();
  expect(parseApplicantSort("score", undefined)).toBeNull();
});

it("toggles direction when the active column is clicked again", () => {
  expect(nextSortDirection({ key: "name", dir: "asc" }, "name")).toBe("desc");
  expect(nextSortDirection({ key: "name", dir: "desc" }, "name")).toBe("asc");
});

it("uses the column's default direction when a new column is clicked", () => {
  // Committee avg opens descending: the common intent is "show me the top scorers".
  expect(nextSortDirection(null, "score")).toBe("desc");
  expect(nextSortDirection({ key: "name", dir: "asc" }, "score")).toBe("desc");
  expect(nextSortDirection(null, "name")).toBe("asc");
  expect(DEFAULT_SORT_DIRECTION.score).toBe("desc");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/modules/recruitment/engine/applicant-sort.test.ts
```

Expected: FAIL with a resolution error, `Failed to load url ./applicant-sort`, because the module does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/modules/recruitment/engine/applicant-sort.ts`:

```ts
import { APPLICATION_STAGE_ORDER, applicationStage } from "./application-stage";
import { ROSTER_DECISION_ORDER, rosterDecision, type Decision } from "./decision-summary";
import { scoreAverage } from "./scoring";
import { applicantTypeLabel, type ApplicantType } from "./visibility";

export const APPLICANT_SORT_KEYS = [
  "name",
  "email",
  "type",
  "score",
  "stage",
  "ranked",
  "decision",
] as const;

export type ApplicantSortKey = (typeof APPLICANT_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";
export type ApplicantSort = { key: ApplicantSortKey; dir: SortDirection };

/** The narrow shape the comparator needs. ReviewApplication satisfies this
 *  structurally, which keeps this module free of Prisma types and testable with
 *  plain object literals. */
export type SortableApplicant = {
  applicant: { firstName: string; lastName: string; email: string };
  applicantType: ApplicantType;
  committeeScores: { score: number }[];
  routedDepartmentCode: string | null;
  decision: Decision;
  interviews: { decision: Decision }[];
  acceptances: { departmentCode: string }[];
  departmentChoices: string[];
};

/** Direction a column opens in on first click. Committee avg opens descending
 *  because the reason to sort it is almost always "who scored highest". */
export const DEFAULT_SORT_DIRECTION: Record<ApplicantSortKey, SortDirection> = {
  name: "asc",
  email: "asc",
  type: "asc",
  score: "desc",
  stage: "asc",
  ranked: "asc",
  decision: "asc",
};

const SORT_KEYS = new Set<string>(APPLICANT_SORT_KEYS);

/** Reads the roster's sort query params. Returns null for anything unrecognised
 *  so a hand-edited URL falls back to the default order instead of erroring. */
export function parseApplicantSort(sort: string | undefined, dir: string | undefined): ApplicantSort | null {
  if (!sort || !SORT_KEYS.has(sort)) return null;
  if (dir !== "asc" && dir !== "desc") return null;
  return { key: sort as ApplicantSortKey, dir };
}

/** Two-state toggle: re-clicking the active column flips it, a new column opens
 *  in that column's default direction. */
export function nextSortDirection(current: ApplicantSort | null, key: ApplicantSortKey): SortDirection {
  if (current?.key === key) return current.dir === "asc" ? "desc" : "asc";
  return DEFAULT_SORT_DIRECTION[key];
}

/** Text a column sorts on, for the columns that compare as text. */
function textFor(a: SortableApplicant, key: "name" | "email" | "type" | "ranked"): string {
  switch (key) {
    case "name":
      // Last name first: this is a people roster, so surname ordering is what
      // reviewers expect even though the cell renders "First Last".
      return `${a.applicant.lastName} ${a.applicant.firstName}`;
    case "email":
      return a.applicant.email;
    case "type":
      return applicantTypeLabel(a.applicantType);
    case "ranked":
      return a.departmentChoices.join(", ");
  }
}

/** Position of a row in its column's meaningful order, rather than its label's
 *  alphabetical order. */
function rankFor(a: SortableApplicant, key: "stage" | "decision"): number {
  if (key === "stage") {
    return APPLICATION_STAGE_ORDER.indexOf(
      applicationStage({
        scoreCount: a.committeeScores.length,
        routedDepartmentCode: a.routedDepartmentCode,
        applicationDecision: a.decision,
        interviews: a.interviews,
      }),
    );
  }
  return ROSTER_DECISION_ORDER.indexOf(
    rosterDecision({
      acceptances: a.acceptances,
      applicationDecision: a.decision,
      interviews: a.interviews,
    }).status,
  );
}

function averageFor(a: SortableApplicant): number | null {
  return scoreAverage(a.committeeScores.map((c) => c.score)).average;
}

/** Sorts a copy of the roster. Array.prototype.sort is stable, so ties keep the
 *  order they arrived in, which is submittedAt desc from listApplicantsForReview. */
export function sortApplicants<T extends SortableApplicant>(apps: T[], sort: ApplicantSort): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...apps].sort((a, b) => {
    if (sort.key === "score") {
      const av = averageFor(a);
      const bv = averageFor(b);
      // Unscored rows sink in both directions, so the column always answers the
      // question the reviewer clicked it to ask.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * sign;
    }
    if (sort.key === "stage" || sort.key === "decision") {
      return (rankFor(a, sort.key) - rankFor(b, sort.key)) * sign;
    }
    return textFor(a, sort.key).localeCompare(textFor(b, sort.key)) * sign;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/modules/recruitment/engine/applicant-sort.test.ts
```

Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/recruitment/engine/applicant-sort.ts src/modules/recruitment/engine/applicant-sort.test.ts
git commit -m "feat(recruitment): add the applicant roster sort comparator"
```

---

### Task 3: The `SortableTH` table primitive

The app has no sortable table today. This adds the header primitive next to the existing `TH`, which stays byte-for-byte identical in behaviour.

**Files:**
- Modify: `src/platform/ui/table.tsx`

**Interfaces:**
- Consumes: `cx` from `./cx`, `Link` from `next/link`, `ChevronDown` / `ChevronUp` / `ChevronsUpDown` from `lucide-react` (all three confirmed present in `lucide-react@0.487.0`).
- Produces, from `@/platform/ui/table`:
  - `SortableTH<K extends string>(props: { columnKey: K; active: { key: K; dir: "asc" | "desc" } | null; hrefFor: (key: K) => string; children: ReactNode; className?: string })`

- [ ] **Step 1: Replace the imports and `TH` block**

In `src/platform/ui/table.tsx`, replace the existing import line at the top:

```ts
import type { ComponentProps } from "react";
```

with:

```ts
import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
```

Then replace the whole existing `TH` function with the shared class constant plus both header components:

```tsx
/** Shared by TH and SortableTH so a sortable header is visually identical to a
 *  plain one apart from its affordance. */
const thClasses = "px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-subtle-foreground";

export function TH({ className, ...rest }: ComponentProps<"th">) {
  return <th scope="col" {...rest} className={cx(thClasses, className)} />;
}

/** A column header that links to the same page sorted by its column. Renders as
 *  a Link rather than a button so the table stays usable from a server component
 *  with no client JavaScript, and so a sorted view is shareable. */
export function SortableTH<K extends string>({
  columnKey,
  active,
  hrefFor,
  children,
  className,
}: {
  columnKey: K;
  active: { key: K; dir: "asc" | "desc" } | null;
  hrefFor: (key: K) => string;
  children: ReactNode;
  className?: string;
}) {
  const dir = active?.key === columnKey ? active.dir : null;
  const Icon = dir === "asc" ? ChevronUp : dir === "desc" ? ChevronDown : ChevronsUpDown;
  return (
    <th
      scope="col"
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
      className={cx(thClasses, className)}
    >
      <Link
        href={hrefFor(columnKey)}
        className={cx(
          "inline-flex items-center gap-1 transition-colors hover:text-foreground",
          dir && "text-foreground",
        )}
      >
        {children}
        <Icon aria-hidden className={cx("h-3.5 w-3.5", !dir && "opacity-40")} />
      </Link>
    </th>
  );
}
```

- [ ] **Step 2: Verify types and lint pass**

```bash
npx tsc --noEmit && npx eslint src/platform/ui/table.tsx
```

Expected: both exit 0 with no output.

- [ ] **Step 3: Verify no existing table regressed**

```bash
npx vitest run
```

Expected: PASS. `TH`'s rendered output is unchanged, so no existing suite should move. If any test fails here, the `TH` edit changed behaviour and must be reverted before continuing.

- [ ] **Step 4: Commit**

```bash
git add src/platform/ui/table.tsx
git commit -m "feat(ui): add a SortableTH column header primitive"
```

---

### Task 4: Wire sorting into the roster page

**Files:**
- Modify: `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx`

**Interfaces:**
- Consumes: `SortableTH` (Task 3); `parseApplicantSort`, `sortApplicants`, `nextSortDirection`, `type ApplicantSortKey` (Task 2).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the imports**

Add to the import block at the top of `page.tsx`:

```ts
import { Table, THead, TR, TH, TD, SortableTH } from "@/platform/ui/table";
import {
  nextSortDirection,
  parseApplicantSort,
  sortApplicants,
  type ApplicantSortKey,
} from "@/modules/recruitment/engine/applicant-sort";
```

The first line replaces the existing `@/platform/ui/table` import, adding `SortableTH` to it.

- [ ] **Step 2: Widen the searchParams type**

Change the component signature so the two new params are typed:

```ts
export default async function ApplicantsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string; decision?: string; sort?: string; dir?: string }> }) {
```

And change the destructure on the following line:

```ts
const { page: pageParam, decision: decisionParam, sort: sortParam, dir: dirParam } = await searchParams;
```

- [ ] **Step 3: Add the query-string helper**

Add at module scope, directly below the existing `DECISION_STATUSES` constant:

```ts
/** Builds the roster's query string from scratch each time. Every roster link
 *  (sort headers, pagination) carries the full state, so no param is dropped by
 *  navigating. Page 1 and the unsorted default are left implicit. */
function rosterQuery(parts: {
  decision: string | null;
  sort: string | null;
  dir: string | null;
  page: number | null;
}): string {
  const q = new URLSearchParams();
  if (parts.decision) q.set("decision", parts.decision);
  if (parts.sort && parts.dir) {
    q.set("sort", parts.sort);
    q.set("dir", parts.dir);
  }
  if (parts.page && parts.page > 1) q.set("page", String(parts.page));
  const s = q.toString();
  return s ? `?${s}` : "";
}
```

- [ ] **Step 4: Sort between the filter and the page slice**

Find these three lines (currently `page.tsx:55-57`):

```ts
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(pageParam) || 1), pageCount);
  const pageApps = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
```

Replace with:

```ts
  const sort = parseApplicantSort(sortParam, dirParam);
  // Sort after filtering and before slicing, so page boundaries stay correct.
  const sorted = sort ? sortApplicants(filtered, sort) : filtered;
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(pageParam) || 1), pageCount);
  const pageApps = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const sortHref = (key: ApplicantSortKey) =>
    // Omitting page returns to page 1, matching how DecisionFilter drops it.
    `/recruitment/cycles/${id}/applicants${rosterQuery({
      decision: decisionFilter,
      sort: key,
      dir: nextSortDirection(sort, key),
      page: null,
    })}`;
```

- [ ] **Step 5: Convert the header row**

Replace the whole existing `<THead>` block:

```tsx
        <THead>
          <tr>
            <TH>Name</TH>
            <TH>Email</TH>
            <TH>Type</TH>
            <TH>Committee avg</TH>
            <TH>Stage</TH>
            <TH>Ranked</TH>
            <TH>Decision</TH>
          </tr>
        </THead>
```

with:

```tsx
        <THead>
          <tr>
            <SortableTH columnKey="name" active={sort} hrefFor={sortHref}>Name</SortableTH>
            <SortableTH columnKey="email" active={sort} hrefFor={sortHref}>Email</SortableTH>
            <SortableTH columnKey="type" active={sort} hrefFor={sortHref}>Type</SortableTH>
            <SortableTH columnKey="score" active={sort} hrefFor={sortHref}>Committee avg</SortableTH>
            <SortableTH columnKey="stage" active={sort} hrefFor={sortHref}>Stage</SortableTH>
            <SortableTH columnKey="ranked" active={sort} hrefFor={sortHref}>Ranked</SortableTH>
            <SortableTH columnKey="decision" active={sort} hrefFor={sortHref}>Decision</SortableTH>
          </tr>
        </THead>
```

Note `TH` is now unused in this file. Remove it from the `@/platform/ui/table` import to keep lint clean, leaving `import { Table, THead, TR, TD, SortableTH } from "@/platform/ui/table";`.

- [ ] **Step 6: Make pagination carry the sort**

Replace the existing `hrefFor` prop on `<Pagination>` (currently `page.tsx:150`):

```tsx
        hrefFor={(p) => `/recruitment/cycles/${id}/applicants?${decisionFilter ? `decision=${decisionFilter}&` : ""}page=${p}`}
```

with:

```tsx
        hrefFor={(p) =>
          `/recruitment/cycles/${id}/applicants${rosterQuery({
            decision: decisionFilter,
            sort: sort?.key ?? null,
            dir: sort?.dir ?? null,
            page: p,
          })}`
        }
```

- [ ] **Step 7: Verify types and lint pass**

```bash
npx tsc --noEmit && npx eslint "src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx"
```

Expected: both exit 0 with no output. A `TH is defined but never used` error here means Step 5's import cleanup was missed.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx"
git commit -m "feat(recruitment): sort the applicant roster by any column"
```

---

### Task 5: Full verification and manual check

**Files:** none modified unless a check fails.

- [ ] **Step 1: Run the full checks in CI order**

CI lints before it tests, so run them in the same order to fail fast on the same thing CI would.

```bash
npm run lint && npm run typecheck && npm run test
```

Expected: all three exit 0. `npm run lint` covers the whole repo, which is required: typecheck and tests do not catch eslint boundary violations.

- [ ] **Step 2: Confirm `DecisionFilter` preserves the sort**

No code change is expected here. `DecisionFilter` clones the existing `URLSearchParams` and only sets or deletes `decision` and `page`, so `sort` and `dir` survive a filter change for free. Read `src/modules/recruitment/components/decision-filter.tsx:30-37` and confirm this is still true. If it is not, fix it before continuing.

- [ ] **Step 3: Manual check in the running app**

```bash
npm run dev
```

Open a cycle's applicants roster and confirm:

1. Every header shows a faint up-down chevron before any sorting is applied.
2. Clicking **Committee avg** sorts highest first on the first click, and the chevron turns solid and points down.
3. Clicking **Committee avg** again flips to lowest first, and applicants showing `-` stay at the bottom in both directions.
4. Clicking **Stage** orders Awaiting scoring, Scoring, Routed, Interviewing, Decided, rather than alphabetically.
5. The URL carries `?sort=...&dir=...`, and pasting it into a new tab reproduces the same view.
6. Changing the **Decision** filter keeps the current sort and returns to page 1.
7. Paging forward keeps the sort, and the sort headers keep the decision filter.
8. Sorting does not trigger a full page reload. The browser tab spinner should not appear.

- [ ] **Step 4: Commit any fixes**

Only if a step above found a defect:

```bash
git add -A
git commit -m "fix(recruitment): <what the manual check turned up>"
```

---

## Notes for the implementer

- **Do not add `"use client"` to the roster page.** The whole point of the link-based header is that the page stays a server component. If you reach for `useState`, something has gone wrong.
- **`ReviewApplication` is never cast.** It structurally satisfies `SortableApplicant`, so `sortApplicants(filtered, sort)` type-checks directly. If it does not, the fix is to correct `SortableApplicant`, not to add an `as`.
- **Blank rows sink by design.** The unscored-last behaviour in both directions is a deliberate product decision, recorded in the spec. Do not "fix" it into treating blank as zero.
