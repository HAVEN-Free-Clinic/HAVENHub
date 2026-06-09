# Schedule Builder Unified View Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the builder's Day view a single per-date screen (current schedule + who is available / not free + inline assign-as-volunteer/shadow/director), keep the Grid view, and restore shadow assignment in the grid via an explicit Volunteer/Shadow toggle.

**Architecture:** `src/app/schedule/builder/page.tsx` is a Next.js App Router server component. It routes between an availability editor, a Grid view (member x date matrix in `BuilderGrid`), and the Day view. This plan: (1) re-routes the page and adds a `?gmode` param + a grid role toggle so the grid can assign shadows again; keeps the Day/Grid toggle and replaces the old mode tabs with an "Edit availability" button; (2) splits the Day view's "Available to assign" list into Available / Not-available subsections; (3) adds e2e coverage. No service/engine/schema changes.

**Tech Stack:** Next.js App Router (server components + server actions), React, Tailwind, TypeScript, Playwright (e2e). Gates: `npm run typecheck`, `npm run lint`, `npm run build`, builder e2e. Run all from the worktree `/Users/jcarney/Documents/Code-Projects/HAVENHub/.claude/worktrees/pr-11-caprice` (it has `node_modules` and `.env` symlinked).

**Spec:** `docs/superpowers/specs/2026-06-08-schedule-builder-unified-view-design.md`

---

## File Structure

- **Modify** `src/app/schedule/builder/page.tsx` — add `?gmode` param + grid role toggle; re-route render; keep Day/Grid toggle; swap mode tabs for an Edit-availability button; split the Day-view unassigned list.
- **Modify** `src/modules/schedule/components/builder-grid.tsx` — narrow `mode` to `"assign" | "shadow"`, remove the dead read-only availability branch, update header comment.
- **Modify** `e2e/schedule.spec.ts` — Day-view shadow assign + subsection assertion + Grid shadow assign.

`builder-grid.tsx` and `builder-cell.tsx` are **kept** (the grid stays). Do **not** delete them.

---

### Task 1: Views & navigation restructure + restore grid shadow

**Files:**
- Modify: `src/app/schedule/builder/page.tsx`
- Modify: `src/modules/schedule/components/builder-grid.tsx`

- [ ] **Step 1: Fix the tripled file-header comment and document the params**

In `src/app/schedule/builder/page.tsx`, replace the three stacked top comment blocks (the original JSDoc plus the two duplicate `/** Schedule Builder page. */` blocks) with:

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
 *   ?view=grid             -- show the Grid view; default (absent) is the Day view
 *   ?gmode=shadow          -- Grid view only: empty-cell click assigns SHADOW;
 *                             default (absent) assigns VOLUNTEER
 *   ?mode=availability      -- show the availability-override editor (over either view)
 */
```

- [ ] **Step 2: Add the `gmode` param to the props and href helpers**

In `src/app/schedule/builder/page.tsx`:

Add `gmode?: string;` to the `searchParams` object in `PageProps` (next to `view`/`mode`).

Add `gmode?: string | null;` to the `HrefParams` type (next to `view`/`mode`).

In `buildHref`, after the `view` line, add:

```tsx
  if (p.gmode) params.set("gmode", p.gmode);
```

In the page body, after `const mode = sp.mode === "availability" ? "availability" : "assign";`, add:

```tsx
  const gmode = sp.gmode === "shadow" ? "shadow" : "assign";
```

In the `href()` helper, add `gmode,` to the defaults object so it sits alongside `view,` and `mode,`:

```tsx
  function href(overrides: HrefParams): string {
    return buildHref("/schedule/builder", {
      dept: dept.id,
      date: selectedDateKey,
      view,
      mode,
      gmode,
      ...overrides,
    });
  }
```

- [ ] **Step 3: Carry `gmode` through every server-action redirect**

Each server action builds `const base = buildHref("/schedule/builder", { dept: dept.id, date: selectedDateKey, view, mode });` and error redirects with the same object plus `error`/`message`. Replace **all** occurrences of the substring:

```tsx
date: selectedDateKey, view, mode
```

with:

```tsx
date: selectedDateKey, view, mode, gmode
```

(Use a replace-all edit. This updates `assignAction`, `unassignAction`, `toggleTagAction`, `saveOverrideAction`, `clearOverrideAction`, `acknowledgeAction`, `patientsBookedAction`, `rhdClinicAction`, `approveRequestAction`, `denyRequestAction`, including their error redirects, so the grid's Volunteer/Shadow selection persists across submits. The multi-line `href()` helper object was already handled in Step 2.)

- [ ] **Step 4: Re-route the main render and add the grid role toggle**

Replace the render block that currently begins `{view === "grid" ? (` and runs through the `<BuilderGrid ... />` and the `) : mode === "availability" ? (` line:

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
          <AvailabilityView
            members={members}
            clinicDates={clinicDates}
            dept={dept}
            saveOverrideAction={saveOverrideAction}
            clearOverrideAction={clearOverrideAction}
            acknowledgeAction={acknowledgeAction}
          />
        ) : view === "grid" ? (
          <>
            <div className="mb-4 flex items-center gap-3">
              <span className="text-sm font-semibold text-slate-600">Assigning as:</span>
              <div className="flex items-center rounded-lg border border-slate-200 overflow-hidden">
                <a
                  href={href({ gmode: "assign" })}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${gmode === "assign" ? "bg-brand text-white" : "text-slate-500 hover:text-slate-700"}`}
                >
                  Volunteer
                </a>
                <a
                  href={href({ gmode: "shadow" })}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-slate-200 ${gmode === "shadow" ? "bg-amber-400 text-white" : "text-slate-500 hover:text-slate-700"}`}
                >
                  Shadow
                </a>
              </div>
            </div>
            <BuilderGrid
              members={members}
              clinicDates={clinicDates}
              assignmentsByDate={assignmentsByDate}
              selectedDateKey={selectedDateKey}
              deptId={dept.id}
              deptCode={dept.code}
              mode={gmode}
              assignAction={assignAction}
              unassignAction={unassignAction}
            />
          </>
        ) : (
```

NOTE: there is now a **second** `<AvailabilityView ... />` usage to remove. The original
`) : mode === "availability" ? ( <AvailabilityView .../> ) :` branch that followed the old
grid branch must be deleted so `AvailabilityView` is only rendered once (in the new first
branch above). After your edit the structure must read: `{mode === "availability" ? (<AvailabilityView/>) : view === "grid" ? (<>grid toggle + BuilderGrid</>) : (<div> day view </div>)}`. Verify there is exactly one `<AvailabilityView` and one `<BuilderGrid` in the file.

- [ ] **Step 5: Keep the Day/Grid toggle but hide it in availability mode, and add the Edit-availability button**

In the hero's right-side controls `<div className="flex items-center gap-3">`, replace the existing `{/* View toggle */}` block:

```tsx
            {/* View toggle */}
            <div className="flex items-center rounded-lg bg-white/10 overflow-hidden">
              <a href={href({ view: "saturday" })} className={`px-3 py-1.5 text-xs font-medium transition-colors ${view === "saturday" ? "bg-white text-brand" : "text-white/70 hover:text-white"}`}>Day view</a>
              <a href={href({ view: "grid" })} className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-white/20 ${view === "grid" ? "bg-white text-brand" : "text-white/70 hover:text-white"}`}>Grid view</a>
            </div>
```

With:

```tsx
            {mode === "availability" ? (
              <a href={href({ mode: "assign" })} className="px-3 py-1.5 rounded-lg bg-white/10 text-xs font-medium text-white/80 hover:text-white transition-colors">
                &larr; Back to assigning
              </a>
            ) : (
              <>
                {/* View toggle */}
                <div className="flex items-center rounded-lg bg-white/10 overflow-hidden">
                  <a href={href({ view: "saturday" })} className={`px-3 py-1.5 text-xs font-medium transition-colors ${view === "saturday" ? "bg-white text-brand" : "text-white/70 hover:text-white"}`}>Day view</a>
                  <a href={href({ view: "grid" })} className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-white/20 ${view === "grid" ? "bg-white text-brand" : "text-white/70 hover:text-white"}`}>Grid view</a>
                </div>
                <a href={href({ mode: "availability" })} className="px-3 py-1.5 rounded-lg bg-white/10 text-xs font-medium text-white/80 hover:text-white transition-colors">
                  Edit availability
                </a>
              </>
            )}
```

In the department selector `<form>`, add a hidden input to preserve `gmode` (next to the existing date/view/mode hidden inputs):

```tsx
              {gmode !== "assign" && <input type="hidden" name="gmode" value={gmode} />}
```

- [ ] **Step 6: Remove the old mode tabs**

Delete the entire `{/* Mode tabs */}` block (the `<div className="flex gap-4 mb-8 border-b border-slate-200">` containing the "Assign shifts" and "View availability" `<a>` tabs).

- [ ] **Step 7: Narrow the grid component to assign/shadow and drop the dead availability branch**

In `src/modules/schedule/components/builder-grid.tsx`:

Update the header comment's "Interaction model by mode" section — delete the
`availability -- entirely read-only; ...` line so only `assign` and `shadow` remain
documented.

Narrow both `mode` types from `"assign" | "shadow" | "availability"` to `"assign" | "shadow"` — in the `Props` type (`mode:` field) and in `GridCellProps` (`mode:` field).

In `GridCell`, delete the read-only availability branch:

```tsx
  // Availability mode: read-only cell.
  if (mode === "availability") {
    return (
      <td
        className={`border border-slate-200 px-2 py-1.5 text-center align-middle min-w-[52px] ${availBg} ${selectedHighlight}`}
        aria-label={ariaLabel}
      >
        <CellContent assignment={assignment} deptCode={deptCode} />
      </td>
    );
  }
```

(Leave everything else, including the `assign` branch, the shadow branches, and the
`CellContent` helper which is still used by the non-shadow read-only filled cell.)

- [ ] **Step 8: Verify no stale references remain**

Run:

```bash
grep -rn "mode=\"availability\"\|\"availability\"" src/modules/schedule/components/builder-grid.tsx
```

Expected: no matches (the grid no longer knows about availability mode).

- [ ] **Step 9: Typecheck, lint, build**

```bash
npm run typecheck && npm run lint && npm run build
```

Expected: all pass. A TS error about `gmode`, a `mode` value of `"availability"` passed to `BuilderGrid`, or a duplicate `AvailabilityView` means a step was missed — fix and rerun.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(schedule): keep grid, add volunteer/shadow toggle, edit-availability button"
```

---

### Task 2: Split the Day view's unassigned list into Available / Not-available

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

Immediately before the `// Render` section's `return (` (alongside `selectedDisplay`), add this helper. It closes over `assignAction`, `dept`, and `selectedDateKey`:

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

Replace the conditional body of the `{/* Column 2: Available to assign */}` `<section>` — the part that currently begins `{!selectedDateKey ? ( ... ) : sortedUnassigned.length === 0 ? ( ... ) : ( <div ...>{sortedUnassigned.map(...)}</div> )}` — with:

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

The section's `Available to assign` heading and its `availableCount` badge stay unchanged.

- [ ] **Step 4: Typecheck, lint, build**

```bash
npm run typecheck && npm run lint && npm run build
```

Expected: all pass. A "`sortedUnassigned` is not defined" error means a leftover reference remains — search the file and remove it.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(schedule): split day-view assign list into available/not-available"
```

---

### Task 3: e2e coverage (Day-view shadow, subsections, Grid shadow)

The builder e2e at `e2e/schedule.spec.ts` already exercises assign + remove and keys off the `Assigned` and `Available to assign` headings, both preserved. Add Day-view and Grid shadow coverage. e2e needs local Postgres seeded: `npm run db:up` (and `npm run db:seed` if the DB is empty).

**Files:**
- Modify: `e2e/schedule.spec.ts`

- [ ] **Step 1: Assert both subsections render in the existing round-trip test**

In the "Builder assign round trip" test, right after the assertion that the `Available to assign` heading is visible (`await expect(availableSection.locator("h2", { hasText: "Available to assign" })).toBeVisible();`), add:

```tsx
  // The unified Day view shows the "said yes" subsection header.
  await expect(availableSection.getByText(/Available · said yes/)).toBeVisible();
```

- [ ] **Step 2: Add a Day-view shadow-assign test**

Append to the end of `e2e/schedule.spec.ts` (reuses the existing `devLogin` and `selectDeptByCode` helpers):

```tsx
test("Builder day-view shadow assign: Jack assigns a member as a shadow via VADM", async ({ page }) => {
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
  const shadowBtn = availableSection.getByRole("button", { name: /Assign as shadow/ }).first();
  await expect(shadowBtn).toBeVisible();
  const memberRow = shadowBtn.locator("xpath=ancestor::div[contains(@class,'rounded-lg')]").first();
  const memberName = (await memberRow.locator("span.font-semibold").first().textContent())?.trim();
  expect(memberName).toBeTruthy();

  await shadowBtn.click();
  await page.waitForLoadState("networkidle");

  const assignedSection = page.locator("section").filter({
    has: page.locator("h2").filter({ hasText: /^Assigned$/ }),
  });
  await expect(assignedSection.getByText(memberName!, { exact: false })).toBeVisible();

  // Clean up so the test is idempotent.
  const removeBtn = assignedSection.getByRole("button", { name: "Remove" }).first();
  await removeBtn.click();
  const confirmBtn = assignedSection.getByRole("button", { name: "Remove this shadow?" }).first();
  await expect(confirmBtn).toBeVisible();
  await confirmBtn.click();
  await page.waitForLoadState("networkidle");
});
```

- [ ] **Step 3: Add a Grid shadow-assign test**

Append this test too:

```tsx
test("Builder grid shadow assign: Jack toggles Shadow and assigns from a grid cell", async ({ page }) => {
  await devLogin(page, "j.carney@yale.edu");
  await page.goto("/schedule/builder");
  await page.waitForURL((url) => url.pathname === "/schedule/builder");

  await selectDeptByCode(page, "VADM");
  await page.getByRole("button", { name: "Go" }).click();
  await page.waitForLoadState("networkidle");

  // Pick a date, then switch to the Grid view.
  await page.locator('nav[aria-label="Clinic dates"]').getByRole("link").first().click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Grid view" }).click();
  await page.waitForLoadState("networkidle");

  // Switch the role toggle to Shadow.
  await page.getByRole("link", { name: "Shadow" }).click();
  await page.waitForLoadState("networkidle");

  // Assign the first available "as shadow" empty cell.
  const shadowCell = page.getByRole("button", { name: /as shadow on/ }).first();
  await expect(shadowCell).toBeVisible();
  await shadowCell.click();
  await page.waitForLoadState("networkidle");

  // A filled SHADOW cell now offers an unassign control; use it to clean up.
  const unassignShadow = page.getByRole("button", { name: /Unassign .*\(shadow\)/ }).first();
  await expect(unassignShadow).toBeVisible();
  await unassignShadow.click();
  await page.waitForLoadState("networkidle");
});
```

- [ ] **Step 4: Run the builder e2e tests**

```bash
npm run db:up
npx playwright test e2e/schedule.spec.ts -g "Builder"
```

Expected: all "Builder ..." tests pass. If the run errors that the database/tables are missing, run `npm run db:seed` and rerun. If the e2e environment cannot be brought up at all in this sandbox, report DONE_WITH_CONCERNS noting that the test file compiles (`npx tsc --noEmit -p .` or the project typecheck passes) but the suite could not be executed here.

- [ ] **Step 5: Commit**

```bash
git add e2e/schedule.spec.ts
git commit -m "test(schedule): cover day-view and grid shadow assignment"
```

---

## Final verification

- [ ] `npm run typecheck && npm run lint && npm run build` all pass.
- [ ] Exactly one `<BuilderGrid` and one `<AvailabilityView` usage remain in `page.tsx`; `grep -n "AvailabilityView\|BuilderGrid" src/app/schedule/builder/page.tsx`.
- [ ] Manual smoke (optional): `npm run dev`, open `/schedule/builder`, pick VADM + a date. Day view shows Assigned + Available/Not-available with volunteer/shadow/director buttons. Hero "Edit availability" opens the editor with a "Back to assigning" link. "Grid view" shows the matrix with an "Assigning as: Volunteer | Shadow" toggle; selecting Shadow and clicking a cell assigns a shadow.
