# Schedule Builder Unified View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the schedule builder's default screen a single per-date view that shows the current schedule alongside who is available ("said yes") and who is not ("not free"), with inline assign-as-volunteer / shadow / director on every member, and remove the dead grid view.

**Architecture:** The builder page (`src/app/schedule/builder/page.tsx`) is a Next.js App Router server component. It already renders an "Assigned" column and an "Available to assign" column in the assign branch. This plan (1) deletes the unreachable grid view and its dead shadow-assignment code, (2) splits the "Available to assign" list into Available / Not-available subsections that both expose volunteer/shadow/director assign buttons, and (3) replaces the mode tab pair with a single "Edit availability" button that links to the existing availability-override editor. No service, engine, or schema changes — all data already comes from `builderView`.

**Tech Stack:** Next.js App Router (server components + server actions), React, Tailwind CSS, TypeScript, Playwright (e2e), Vitest (unit). Verification gates: `npm run typecheck`, `npm run lint`, `npm run build`, and the builder e2e test.

**Spec:** `docs/superpowers/specs/2026-06-08-schedule-builder-unified-view-design.md`

---

## File Structure

- **Modify** `src/app/schedule/builder/page.tsx` — remove grid view + `view` param; split the unassigned list into two subsections; swap mode tabs for an Edit-availability button.
- **Delete** `src/modules/schedule/components/builder-grid.tsx` — the dead cross-date grid (only consumer was the removed grid view).
- **Modify** `src/modules/schedule/components/builder-cell.tsx` — drop the now-unused `grid` and `grid-filled` variants.
- **Modify** `e2e/schedule.spec.ts` — extend the builder round-trip test to cover shadow assignment and assert both subsections render.

All four files in this plan change together for one feature, so they are implemented as four small tasks against the same branch (`caprice` worktree).

---

### Task 1: Remove the grid view and dead shadow code

This closes review issue #2 (the `?mode=shadow` dead path) by deleting the grid entirely.

**Files:**
- Modify: `src/app/schedule/builder/page.tsx`
- Delete: `src/modules/schedule/components/builder-grid.tsx`
- Modify: `src/modules/schedule/components/builder-cell.tsx`

- [ ] **Step 1: Fix the tripled file-header comment and drop grid/shadow from the doc**

In `src/app/schedule/builder/page.tsx`, replace the three stacked comment blocks at the very top (the original JSDoc plus the two duplicate `/** Schedule Builder page. */` blocks) with a single corrected block.

Replace:

```tsx
/**
 * Schedule Builder page.
 *
 * Gate: requireModuleAccess("schedule").
 * Scope: per-department; actor must manage at least one department.
 *
 * URL params:
 *   ?dept=<departmentId>   -- selected department
 *   ?date=<YYYY-MM-DD>     -- selected clinic date
 *   ?view=saturday|grid    -- view toggle (grid is a placeholder for Task 8)
 *   ?mode=assign|shadow|availability -- mode toggle
 */

/**
 * Schedule Builder page.
 */

/**
 * Schedule Builder page.
 */
```

With:

```tsx
/**
 * Schedule Builder page.
 *
 * Gate: requireModuleAccess("schedule").
 * Scope: per-department; actor must manage at least one department.
 *
 * URL params:
 *   ?dept=<departmentId>   -- selected department
 *   ?date=<YYYY-MM-DD>     -- selected clinic date
 *   ?mode=availability     -- show the availability-override editor; default is the
 *                             unified assign view.
 */
```

- [ ] **Step 2: Remove the BuilderGrid import**

In `src/app/schedule/builder/page.tsx`, delete this import line:

```tsx
import { BuilderGrid } from "@/modules/schedule/components/builder-grid";
```

- [ ] **Step 3: Remove the `view` URL param from the page props and href helpers**

In `src/app/schedule/builder/page.tsx`:

Remove `view?: string;` from the `searchParams` object in `PageProps`.

Remove `view?: string | null;` from the `HrefParams` type.

In `buildHref`, delete this line:

```tsx
  if (p.view) params.set("view", p.view);
```

Delete the `view` local in the page body:

```tsx
  const view = sp.view === "grid" ? "grid" : "saturday";
```

- [ ] **Step 4: Strip `view` from every href/action call site**

In `src/app/schedule/builder/page.tsx`, the `view` variable no longer exists, so every `buildHref`/`href` call that referenced it must drop it. Every reference uses the exact substring `date: selectedDateKey, view, mode`. Replace **all occurrences** of:

```tsx
date: selectedDateKey, view, mode
```

with:

```tsx
date: selectedDateKey, mode
```

This covers the `href()` helper default object and all server actions (`assignAction`, `unassignAction`, `toggleTagAction`, `saveOverrideAction`, `clearOverrideAction`, `acknowledgeAction`, `patientsBookedAction`, `rhdClinicAction`, `approveRequestAction`, `denyRequestAction`) including their error redirects.

- [ ] **Step 5: Remove the Day/Grid toggle and the hidden `view` input from the hero**

In the hero block, delete the entire view-toggle element:

```tsx
            {/* View toggle */}
            <div className="flex items-center rounded-lg bg-white/10 overflow-hidden">
              <a href={href({ view: "saturday" })} className={`px-3 py-1.5 text-xs font-medium transition-colors ${view === "saturday" ? "bg-white text-brand" : "text-white/70 hover:text-white"}`}>Day view</a>
              <a href={href({ view: "grid" })} className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-white/20 ${view === "grid" ? "bg-white text-brand" : "text-white/70 hover:text-white"}`}>Grid view</a>
            </div>
```

In the department selector `<form>`, delete the hidden `view` input:

```tsx
              {view !== "saturday" && <input type="hidden" name="view" value={view} />}
```

- [ ] **Step 6: Collapse the render conditional to drop the grid branch**

In the main content render, replace:

```tsx
      <div>
        {view === "grid" ? (
          <BuilderGrid
            members={members}
            clinicDates={clinicDates}
            assignmentsByDate={assignmentsByDate}
            selectedDateKey={selectedDateKey}
            deptId={dept.id}
            deptCode={dept.code}
            mode={mode}
            assignAction={assignAction}
            unassignAction={unassignAction}
          />
        ) : mode === "availability" ? (
```

With:

```tsx
      <div>
        {mode === "availability" ? (
```

(The closing structure is unchanged: the `: (` for the unified two-column layout and its trailing `)}` stay as they are.)

- [ ] **Step 7: Delete the grid component file**

```bash
git rm src/modules/schedule/components/builder-grid.tsx
```

- [ ] **Step 8: Remove the unused grid variants from BuilderCell**

In `src/modules/schedule/components/builder-cell.tsx`:

Update the variant doc comment block — delete these two lines:

```tsx
//   grid        -- compact grid cell: empty slot, shows "+".
//   grid-filled -- compact grid cell: filled slot, shows role glyph + tag dots.
```

Narrow the `Variant` type:

```tsx
type Variant = "assign" | "tag" | "remove" | "grid" | "grid-filled";
```

becomes:

```tsx
type Variant = "assign" | "tag" | "remove";
```

Delete the two grid branches in `SubmitButton` — the entire `if (variant === "grid") { ... }` block and the entire `if (variant === "grid-filled") { ... }` block (lines rendering the `+` cell and the role-glyph cell). Keep everything from `const cls =` downward.

The `assignment?: BuilderAssignmentEntry` prop and the `TAG_SHORT` map were only used by the grid-filled branch. Remove the `assignment` prop from both the `Props` type and the `SubmitButton` params (and the spot where it is passed in `BuilderCell`), remove the `BuilderAssignmentEntry` import, and remove the `TAG_SHORT` constant. Also remove the now-stale `/** For grid-filled variant: ... */` and `/** Accessible label for grid cells ... */` doc comments and the `ariaLabel` prop **only if** `ariaLabel` is no longer referenced after the grid branches are gone — grep first (next step) and keep `ariaLabel` if the `assign`/`tag`/`remove` path still uses it.

- [ ] **Step 9: Verify nothing else referenced the removed symbols**

Run:

```bash
grep -rn "BuilderGrid\|builder-grid\|grid-filled\|view=grid\|view: \"grid\"\|name=\"view\"" src e2e
```

Expected: no matches (empty output). If `e2e/schedule.spec.ts` matches, it is handled in Task 4 — note it and continue.

- [ ] **Step 10: Typecheck, lint, build**

```bash
npm run typecheck && npm run lint && npm run build
```

Expected: all three pass with no errors. A TypeScript error naming `view`, `BuilderGrid`, `grid`, `assignment`, or `TAG_SHORT` means a reference was missed in Steps 4-8 — fix and rerun.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor(schedule): remove dead grid view and shadow mode from builder"
```

---

### Task 2: Split the unassigned list into Available / Not-available subsections

**Files:**
- Modify: `src/app/schedule/builder/page.tsx`

- [ ] **Step 1: Replace the sort/count helpers with an available/not-available partition**

Find and delete this block (the `sortedUnassigned` / `availableCount` definitions):

```tsx
  const sortedUnassigned = [...unassignedMembers].sort((a, b) => {
    const aAvail = selectedDateKey
      ? a.availability.dates.some((d) => isoDateKey(d) === selectedDateKey)
      : false;
    const bAvail = selectedDateKey
      ? b.availability.dates.some((d) => isoDateKey(d) === selectedDateKey)
      : false;
    if (aAvail && !bAvail) return -1;
    if (!aAvail && bAvail) return 1;
    return a.person.name.localeCompare(b.person.name);
  });

  const availableCount = sortedUnassigned.filter((m) =>
    selectedDateKey
      ? m.availability.dates.some((d) => isoDateKey(d) === selectedDateKey)
      : false
  ).length;
```

Replace with:

```tsx
  const isAvailableOnDate = (m: (typeof unassignedMembers)[number]) =>
    selectedDateKey
      ? m.availability.dates.some((d) => isoDateKey(d) === selectedDateKey)
      : false;

  const byName = (
    a: (typeof unassignedMembers)[number],
    b: (typeof unassignedMembers)[number],
  ) => a.person.name.localeCompare(b.person.name);

  const availableMembers = unassignedMembers.filter(isAvailableOnDate).sort(byName);
  const notAvailableMembers = unassignedMembers
    .filter((m) => !isAvailableOnDate(m))
    .sort(byName);
  const availableCount = availableMembers.length;
```

- [ ] **Step 2: Add a local `assignCard` render helper above the `return`**

Immediately before the `// Render` section's `return (` in the page body (after the server actions, alongside `selectedDisplay`), add this helper. It closes over `assignAction`, `dept`, and `selectedDateKey`, and renders one member's assign card; the `available` flag controls styling and whether the buttons carry a warning marker.

```tsx
  function assignCard(member: (typeof unassignedMembers)[number], available: boolean) {
    const isDirectorKind = member.kind === "DIRECTOR";
    const warn = available ? "" : " ⚠";
    return (
      <div
        key={member.person.id}
        className={`rounded-lg border px-3 py-3 ${
          available ? "border-emerald-200 bg-emerald-50/30" : "border-slate-200 bg-slate-50 opacity-75"
        }`}
      >
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="text-sm font-semibold text-slate-800">{member.person.name}</span>
          <Badge tone={isDirectorKind ? "brand" : "default"}>
            {isDirectorKind ? "Director" : "Volunteer"}
          </Badge>
          {!available && (
            <span className="text-xs font-semibold text-amber-700 bg-amber-100 rounded-full px-2 py-0.5">
              not free
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {isDirectorKind && (
            <BuilderCell
              action={assignAction}
              hidden={{
                departmentId: dept.id,
                dateKey: selectedDateKey ?? "",
                personId: member.person.id,
                role: "DIRECTOR",
              }}
              label={`Assign as director${warn}`}
              variant="assign"
            />
          )}
          <BuilderCell
            action={assignAction}
            hidden={{
              departmentId: dept.id,
              dateKey: selectedDateKey ?? "",
              personId: member.person.id,
              role: "VOLUNTEER",
            }}
            label={`Assign as volunteer${warn}`}
            variant="assign"
          />
          <BuilderCell
            action={assignAction}
            hidden={{
              departmentId: dept.id,
              dateKey: selectedDateKey ?? "",
              personId: member.person.id,
              role: "SHADOW",
            }}
            label={`Assign as shadow${warn}`}
            variant="assign"
          />
        </div>
      </div>
    );
  }
```

- [ ] **Step 3: Render the two subsections in the "Available to assign" column**

Replace the body of the `{/* Column 2: Available to assign */}` `<section>` — that is, the conditional that currently begins `{!selectedDateKey ? ( ... ) : sortedUnassigned.length === 0 ? ( ... ) : ( <div ...> {sortedUnassigned.map(...)} </div> )}` — with:

```tsx
              {!selectedDateKey ? (
                <div className="rounded-xl border-2 border-dashed border-slate-200 px-6 py-10 text-center text-sm text-slate-400">
                  Select a date above to start assigning.
                </div>
              ) : (
                <div className="flex flex-col gap-5">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-emerald-600 mb-2">
                      Available &middot; said yes ({availableMembers.length})
                    </p>
                    {availableMembers.length === 0 ? (
                      <p className="text-sm text-slate-400 italic">No one is marked available for this date.</p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {availableMembers.map((m) => assignCard(m, true))}
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2">
                      Not available ({notAvailableMembers.length})
                    </p>
                    {notAvailableMembers.length === 0 ? (
                      <p className="text-sm text-slate-300 italic">Everyone else is already assigned.</p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {notAvailableMembers.map((m) => assignCard(m, false))}
                      </div>
                    )}
                  </div>
                </div>
              )}
```

The section's heading and the `availableCount` badge above this block are unchanged.

- [ ] **Step 4: Typecheck, lint, build**

```bash
npm run typecheck && npm run lint && npm run build
```

Expected: all pass. A "`sortedUnassigned` is not defined" error means a leftover reference remains — search the file for `sortedUnassigned` and remove it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(schedule): split builder assign list into available/not-available"
```

---

### Task 3: Replace the mode tabs with an Edit-availability button

**Files:**
- Modify: `src/app/schedule/builder/page.tsx`

- [ ] **Step 1: Delete the mode tab pair**

Remove the entire `{/* Mode tabs */}` block:

```tsx
      {/* Mode tabs */}
      <div className="flex gap-4 mb-8 border-b border-slate-200">
        <a
          href={href({ mode: "assign" })}
          className={`pb-3 text-sm font-semibold border-b-2 transition-colors ${mode === "assign" ? "border-brand text-brand" : "border-transparent text-slate-400 hover:text-slate-600"}`}
        >
          Assign shifts
          <span className="block text-xs font-normal mt-0.5">Add directors, volunteers, and shadows to this date</span>
        </a>
        <a
          href={href({ mode: "availability" })}
          className={`pb-3 text-sm font-semibold border-b-2 transition-colors ${mode === "availability" ? "border-brand text-brand" : "border-transparent text-slate-400 hover:text-slate-600"}`}
        >
          View availability
          <span className="block text-xs font-normal mt-0.5">See who is available across all clinic dates</span>
        </a>
      </div>
```

- [ ] **Step 2: Add the Edit-availability / Back-to-assigning link to the hero**

In the hero's right-side controls `<div className="flex items-center gap-3">`, immediately before the department selector `<form method="GET" ...>`, insert a single mode-toggle link:

```tsx
            {/* Availability editor toggle */}
            {mode === "availability" ? (
              <a href={href({ mode: "assign" })} className="px-3 py-1.5 rounded-lg bg-white/10 text-xs font-medium text-white/80 hover:text-white transition-colors">
                &larr; Back to assigning
              </a>
            ) : (
              <a href={href({ mode: "availability" })} className="px-3 py-1.5 rounded-lg bg-white/10 text-xs font-medium text-white/80 hover:text-white transition-colors">
                Edit availability
              </a>
            )}
```

The hidden `mode` input already present in the department `<form>` (`{mode !== "assign" && <input type="hidden" name="mode" value={mode} />}`) is correct as-is and stays — it preserves availability mode when switching departments.

- [ ] **Step 3: Typecheck, lint, build**

```bash
npm run typecheck && npm run lint && npm run build
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(schedule): replace builder mode tabs with edit-availability toggle"
```

---

### Task 4: Extend the builder e2e for shadow assignment and the not-available group

The builder e2e at `e2e/schedule.spec.ts` ("Builder assign round trip") already exercises assign + remove and keys off the `Assigned` and `Available to assign` headings, both preserved. This task adds coverage for the new subsections and shadow assignment. e2e needs the local Postgres + seed: `npm run db:up` then `npm run db:seed` if not already seeded.

**Files:**
- Modify: `e2e/schedule.spec.ts`

- [ ] **Step 1: Add an assertion that both subsections render**

In the "Builder assign round trip" test, after the block that selects a date and asserts the `Available to assign` heading is visible (after `await expect(availableSection.locator("h2", { hasText: "Available to assign" })).toBeVisible();`), add:

```tsx
  // The unified view shows the available ("said yes") subsection header.
  await expect(availableSection.getByText(/Available · said yes/)).toBeVisible();
```

- [ ] **Step 2: Add a shadow-assignment test**

Append this test to the end of `e2e/schedule.spec.ts` (it reuses the existing `devLogin` and `selectDeptByCode` helpers already imported in the file):

```tsx
test("Builder shadow assign: Jack assigns a member as a shadow via VADM", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/schedule/builder");
  await page.waitForURL((url) => url.pathname === "/schedule/builder");

  await selectDeptByCode(page, "VADM");
  await page.getByRole("button", { name: "Go" }).click();
  await page.waitForLoadState("networkidle");

  const dateNav = page.locator('nav[aria-label="Clinic dates"]');
  await dateNav.getByRole("link").first().click();
  await page.waitForLoadState("networkidle");

  const availableSection = page.locator("section").filter({
    has: page.locator("h2", { hasText: "Available to assign" }),
  });

  // Capture the member name from the first row that has an "Assign as shadow" button.
  const shadowBtn = availableSection
    .getByRole("button", { name: /Assign as shadow/ })
    .first();
  await expect(shadowBtn).toBeVisible();
  const memberRow = shadowBtn.locator("xpath=ancestor::div[contains(@class,'rounded-lg')]").first();
  const memberName = (await memberRow.locator("span.font-semibold").first().textContent())?.trim();
  expect(memberName).toBeTruthy();

  await shadowBtn.click();
  await page.waitForLoadState("networkidle");

  // The member now appears under the Shadows group in the Assigned section.
  const assignedSection = page.locator("section").filter({
    has: page.locator("h2").filter({ hasText: /^Assigned$/ }),
  });
  await expect(assignedSection.getByText(memberName!, { exact: false })).toBeVisible();

  // Clean up: remove the shadow so the test is idempotent.
  const removeBtn = assignedSection.getByRole("button", { name: "Remove" }).first();
  await removeBtn.click();
  const confirmBtn = assignedSection.getByRole("button", { name: "Remove this shadow?" }).first();
  await expect(confirmBtn).toBeVisible();
  await confirmBtn.click();
  await page.waitForLoadState("networkidle");
});
```

- [ ] **Step 3: Run the builder e2e tests**

```bash
npm run db:up
npx playwright test e2e/schedule.spec.ts -g "Builder"
```

Expected: the "Builder assign round trip", "Builder shadow assign", and the other "Builder ..." tests pass. If the run reports the database is missing tables, run `npm run db:seed` first, then rerun.

- [ ] **Step 4: Commit**

```bash
git add e2e/schedule.spec.ts
git commit -m "test(schedule): cover shadow assign and available/not-available split"
```

---

## Final verification

- [ ] Run the full gate once more: `npm run typecheck && npm run lint && npm run build`
- [ ] Confirm no dead references remain: `grep -rn "BuilderGrid\|grid-filled\|view=grid" src e2e` returns nothing.
- [ ] Manual smoke (optional): `npm run dev`, open `/schedule/builder`, pick VADM + a date, confirm the Assigned column, the Available/Not-available subsections with volunteer/shadow/director buttons, and the hero "Edit availability" button (which opens the override editor with a "Back to assigning" link).
