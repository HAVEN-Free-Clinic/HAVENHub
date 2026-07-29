# Department Names in the Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An applicant can tell which department they are choosing, at the moment they choose it and again when they review it.

**Architecture:** Resolve department names once, server-side, where `/apply/[slug]/page.tsx` builds the form definition. Two consumers (`wizard-review.tsx` and `schema-builder.ts`) already resolve labels through the field's own `options` and need no change. The section title is substituted in the same place, so both of its render sites are fixed at once.

**Tech Stack:** Next.js App Router, Prisma, Vitest, Zod via the existing `schema-builder`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-department-names-in-apply-design.md`. Read it before Task 1.
- Source finding: PR #474, `docs/full-app-ux-audit-2026-07-29.md`, item R2 / F-04-1.
- **No em-dashes anywhere, in prose or code.** CI enforces this via the `local/no-em-dash` eslint rule.
- **The injection is read-time only.** `FormField.options` stays null in the database and the form builder is never touched. `src/modules/recruitment/engine/field-types.ts:28` declares `hasOptions: false` for `DEPARTMENT_CHOICE` because directors do not author these options; the cycle's department list defines them.
- **A code with no matching `Department` row must keep the code as its own label** and must remain submittable. Aliases and deleted departments degrade to today's behavior rather than vanishing.
- Option order follows `cycle.departments`, not alphabetical, so a director's intended ordering survives.
- Lint with `npx eslint src`. Plain `npm run lint` walks a gitignored design-system directory and produces noise. Run `npm run typecheck` before each commit.
- `main` carries 6 to 9 pre-existing storage and ordering test flakes (disk writes, blob cleanup, `listAcceptances` order). They are not yours. Compare against `main` before assuming you broke something.

## File structure

- Modify: `src/app/apply/[slug]/page.tsx` (resolve names; inject options; substitute the title)
- Modify: `src/modules/recruitment/components/field-preview.tsx` (render the label)
- Modify: `src/platform/ui/form.tsx` (allow a link in a section description)
- Modify: `src/modules/recruitment/templates/field-groups.ts` (make the pointer a link)
- Modify: `src/modules/recruitment/templates/application/volunteer.ts` and `director.ts` (title from the name)
- Test: `src/app/apply/[slug]/` or the nearest existing recruitment service test location, per Task 1 Step 1

---

### Task 1: Resolve department names and render them in the dropdown

**Files:**
- Modify: `src/app/apply/[slug]/page.tsx:73-84` (the `def` object)
- Modify: `src/modules/recruitment/components/field-preview.tsx:120`
- Test: see Step 1

**Interfaces:**
- Produces: `DEPARTMENT_CHOICE` fields carrying `options: { value: string; label: string }[]` in the form definition the apply page passes to the wizard. Tasks 2 and 3 do not depend on this.

- [ ] **Step 1: Find where to put the test, and read the conventions**

The logic worth testing is "given a cycle's department codes and the `Department` table, produce the option list". Before writing anything, decide whether that belongs:

- extracted into a small pure helper with a unit test (preferred, because `page.tsx` is a server component and awkward to test directly), or
- tested through an existing recruitment service test that already builds a cycle

Read `src/modules/recruitment/services/cycles.test.ts` and `src/modules/recruitment/services/submissions.test.ts` for the file's fixture conventions before choosing. State your choice and why in your report. Do not restructure `page.tsx` beyond extracting a helper.

- [ ] **Step 2: Write the failing tests**

Cover exactly these cases:

```
- resolves each code to its Department.name
- preserves the order of cycle.departments rather than sorting
- falls back to the code as its own label when no Department row matches
- returns an empty list when the cycle has no departments
```

- [ ] **Step 3: Run them and watch them fail**

Run the focused test file. Expected: failures naming the missing helper.

- [ ] **Step 4: Implement the resolver and inject**

Load `Department` rows for `cycle.departments` (`code` and `name`), build the ordered option list, and inject it into every field whose `type` is `"DEPARTMENT_CHOICE"` as `def` is built at `page.tsx:73-84`.

~~Note `page.tsx` already runs a `prisma.department.findMany` for subcommittees nearby; check whether you can widen that query rather than adding a second round trip.~~

**Corrected 2026-07-29:** that premise was wrong. The nearby query is `prisma.subcommittee.findMany` on a different model; there was no `Department` query to widen. A second query is correct here, gated on `cycle.departments.length` so a cycle with no departments skips the round trip.

- [ ] **Step 5: Render the label**

`src/modules/recruitment/components/field-preview.tsx:120` currently renders:

```tsx
{departments.map((d) => <option key={d} value={d}>{d}</option>)}
```

Render `f.options` when present, falling back to the existing `departments` mapping when absent.

**The fallback is load-bearing.** The same component renders the form builder's live preview, where nothing has injected options. Removing it would blank the dropdown in the builder.

- [ ] **Step 6: Pin the validation change**

This is the consequence the spec calls out, and it must not arrive as a surprise. `src/modules/recruitment/engine/schema-builder.ts:116-120` builds a `z.enum` over the option values when options exist and a free `z.string()` when they do not. Today a `DEPARTMENT_CHOICE` answer is unvalidated: any string round-trips.

**Corrected 2026-07-29:** that last sentence is false and the spec has retracted it (see `docs/superpowers/specs/2026-07-29-department-names-in-apply-design.md`, "Consequences worth stating"). `submissions.ts`'s `toSectionDefs` has self-supplied `DEPARTMENT_CHOICE` options from `cycle.departments` since commit `167c587f2` (2026-06-08), independent of `FormField.options`, so server-side validation against the cycle's department list was already enforced before this branch. The test below still exists and is worth keeping, but it pins pre-existing behavior; it does not close a validation hole.

Add a test asserting both directions:

```
- a submission whose department code IS in the cycle's list is accepted
- a submission whose department code is NOT in the cycle's list is now rejected
```

Read `submissions.test.ts` for how it drives `submitApplication` and asserts rejections. If this test proves impractical to write at the submission level, test it at the `schema-builder` level instead and say so; do not skip it.

- [ ] **Step 7: Run everything this touches**

```bash
npx vitest run src/modules/recruitment src/app
```

Expected: green. A pre-existing storage flake is not yours; compare against `main` before investigating.

- [ ] **Step 8: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "fix(apply): show department names in the application dropdown"
```

---

### Task 2: Make the department descriptions pointer a real link

**Files:**
- Modify: `src/platform/ui/form.tsx:9-28`
- Modify: `src/modules/recruitment/templates/field-groups.ts:82`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Widen the description type**

`src/platform/ui/form.tsx` types `FormSection`'s `description` as `string` and renders it inside a `<p>`. `ReactNode` is already imported at `:1`.

Widen `description?: string` to `description?: ReactNode`. The render site needs no change; a `<p>` accepts any node.

Check for other `FormSection` callers that pass a description and confirm none breaks. A widening is source-compatible, but confirm rather than assume.

- [ ] **Step 2: Make the pointer a link**

`src/modules/recruitment/templates/field-groups.ts:82` sets the section description to the literal string "See department descriptions at havenfreeclinic.com/apply".

Turn the URL into an anchor. Two things to get right:

- The template module feeds both the live form and the materializer, so check whether `description` is persisted to `FormSection.description` by `src/modules/recruitment/templates/materialize.ts`. **If it is persisted, a `ReactNode` cannot go in the template**, because the database column is text. In that case leave the template string alone and render the link at display time instead, or store a URL alongside the text. Determine which before editing, and say what you found in your report.
- The link points outside the app. Follow how the codebase renders external links; `src/platform/ui/external-link-button.tsx` exists, and `ExternalLinkButton` is used elsewhere in the apply flow. A button may be too heavy for an inline sentence; an anchor with the same safety attributes may fit better. Use your judgment and say why.

- [ ] **Step 3: Verify by eye**

Bring up the environment and load the apply form for a cycle with departments. Confirm the sentence renders with a working link that opens the descriptions page.

Environment: `.env.local` does not exist in this worktree. Copy it from `/Users/jcarney/Documents/Code-Projects/HAVENHub/.claude/worktrees/fix+hipaa-verification-wait/.env.local`, which points at `havenhub_uxaudit` on localhost:5434. It is gitignored and must not be committed. There is an open cycle at slug `ux-audit-cycle`.

Start your own dev server with `run_in_background: true`. It dies with your session, which is fine because you both start and use it. Use Playwright MCP; the Chrome extension is not connected.

- [ ] **Step 4: Commit**

```bash
npx eslint src && npm run typecheck
git add -A src
git commit -m "fix(apply): link the department descriptions pointer"
```

---

### Task 3: Show the department name in the generated section title

**Files:**
- Modify: `src/modules/recruitment/templates/application/volunteer.ts:10`
- Modify: `src/modules/recruitment/templates/application/director.ts:10`
- Modify: `src/app/apply/[slug]/page.tsx` (the same `def` build as Task 1)
- Test: alongside Task 1's tests

**Interfaces:**
- Consumes: the department name map from Task 1. Reuse its helper rather than resolving names twice.

**Read this before writing code.** Both templates build `title: \`${norm} department questions\``, and `src/modules/recruitment/templates/materialize.ts:7` writes that title into `FormSection` at cycle creation. **The code is therefore already persisted in every existing cycle**, including any currently open one. Changing the templates fixes only cycles created afterward, so both halves below are required.

Both render sites (`apply-wizard.tsx:466` progress rail and `:473` step heading) read from the same `def.sections`, so substituting once where `def` is built fixes both.

- [ ] **Step 1: New cycles, from the template**

In both template files, build the title from the department name rather than the code. The template already has the normalized code; it needs the name. Decide how the name reaches it: a lookup passed into the template builder, or the title left as-is with the substitution in Step 2 covering every cycle uniformly.

**The second option is worth serious consideration.** If the render-time substitution in Step 2 handles all cycles correctly, changing the templates adds a second mechanism for no extra coverage, and the spec's own risk note warns that a drifting pattern between generator and matcher is the fragile part of this change. If you conclude the substitution alone is sufficient, say so with reasoning and skip the template change; that is a legitimate outcome of this step, not a shortcut.

- [ ] **Step 2: Existing cycles, at render time**

Where `def` is built in `page.tsx`, replace a section's title with the name-based version **only when the stored title still equals the generated default for that section's `departmentCode`**.

The matcher must be exact. A director who renamed the section keeps their title untouched. Build the expected default from the same expression the template uses, and keep the two next to each other so they cannot drift silently.

- [ ] **Step 3: Test all three cases**

```
- a section whose stored title is the generated default renders the department name
- a section whose title was customized by a director is left exactly as stored
- a section whose departmentCode has no matching Department row keeps the stored title
```

Add a test asserting the matcher and the generator agree, so a future change to one fails loudly rather than silently disabling the substitution. The spec names this as the main risk.

- [ ] **Step 4: Run everything**

```bash
npx vitest run src/modules/recruitment src/app
npx eslint src && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "fix(apply): show the department name in the generated section title"
```

---

## Self-review notes

**Spec coverage.** Design section 1 maps to Task 1 Steps 1 through 4; section 2 to Task 1 Step 5; section 3 to Task 2; section 4 to Task 3. The spec's "Consequences worth stating" maps to Task 1 Step 6, which pins the validation change in both directions. The spec's named risk (generator and matcher drifting apart) maps to Task 3 Step 3's agreement test.

**Corrected 2026-07-29:** "pins the validation change" is stale in the same way as the Task 1 Step 6 text it describes. Task 1 Step 6's test pins pre-existing validation behavior, not a change; see the correction there and the spec's "Consequences worth stating" for the retraction.

**Two steps deliberately leave a decision to the implementer**, each with the information needed to make it and an instruction to report the reasoning: Task 2 Step 2 (whether the template description is persisted, which decides where the link can live) and Task 3 Step 1 (whether changing the templates adds coverage over the render-time substitution, or just a second mechanism to keep in sync). Both are questions I could not settle without reading code the implementer will have open anyway, and guessing wrong in the plan would be worse than asking.

**Not covered: mobile width.** Department names are longer than codes and land in a dropdown, a review row, and a step title. The spec flags this; no task verifies it, because the audit could not check mobile viewports either. Worth a manual look before merge.
