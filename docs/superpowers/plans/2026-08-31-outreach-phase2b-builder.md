# Outreach Phase 2, Part B: The Audience Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Part B of two.** Part A (`2026-08-31-outreach-phase2-audience-depth.md`) is the engine and data work and MUST land first: the controls in Task B3 exist to create the date and count conditions Part A defines. Both parts ship on the same branch and merge together.

**Goal:** Rebuild the audience builder so a fifty-field, deeply nested condition tree is legible, and so a sender can see who they are about to email before they send.

**Architecture:** The editor becomes tabbed (Compose / Audience / Review) instead of one long scrolling page, and the Audience tab becomes two panes: the condition tree on the left, a live preview on the right. The preview is what makes a nested tree comprehensible, because every group and condition reports how many people it matches on its own.

**Spec:** `docs/superpowers/specs/2026-08-31-outreach-campaigns-design.md`, section "Builder UI".

## Global Constraints

- **No em-dash (U+2014) anywhere in `src/**/*.{ts,tsx}`.** CI-enforced by `local/no-em-dash`, including inside comments.
- **Permission strings must be prefixed by their module id** and declared in a `MODULES` registry entry.
- **Never weaken an authorization gate while refactoring.** The campaign editor's page gate, `assertScopeOrRedirect`, and every action's `CampaignScopeError` handling came out of a Phase 1 security review. Task B1 moves code around them; it must not change what they enforce.
- **`assertScopeOrRedirect` and any helper a `"use server"` closure references MUST live at module scope**, not inside the page component. A render-scope function referenced from a server action is serialized as a bound argument, is not serializable, and kills every action on the page at runtime while still compiling cleanly. This exact bug shipped once in Phase 1 and was caught only by the whole-branch review.
- **Match counts are a preview, never an authorization boundary.** Every count query runs through the same scope-aware resolver as a real send, so a scoped sender never sees a count that includes people outside their scope.
- **Do not run the full local suite as a gate.** Run the focused files each task names, plus `npx tsc --noEmit` and `npx eslint src e2e`, then push and let CI be the authority.

## Test database

```
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth
```

## Task map

| # | Task | Depends on |
|---|---|---|
| B0 | HIPAA certificate expiry field | Part A complete |
| B1 | Editor shell: tabs, two-pane layout, extracted actions | Part A complete |
| B2 | Searchable grouped field picker | B1 |
| B3 | Date, number, and relative-window controls | B1, Part A Tasks 1-2 |
| B4 | Per-node live match counts | B1 |
| B5 | Recipient preview and manual list UI | B1, B4, Part A Task 8 |

---

### Task B0: HIPAA certificate expiry field

Part A's whole-branch review found that the field this entire phase argues from did not ship. "Certificates expiring in the next 30 days" is cited three times in the spec as the reason date conditions exist, and it is still not expressible: Part A shipped `hipaaCompletedAt` and `hipaaVerifiedAt`, not expiry.

Expressing it today means ANDing `hipaaCompletedAt withinLastDays 365` against a NONE group holding `withinLastDays 335`, which no sender will discover. `complianceStatus = EXPIRING_SOON` only offers a hard-coded 60-day bucket, not an arbitrary window.

**This task comes first** because it is the phase's headline use case, and because it is engine work that the builder tasks then get to exercise.

Expiry is DERIVED, not stored: `compliance/rules.ts` computes it as completion plus one year. So this is not a plain relation date. Read how `complianceStatus` is precomputed via `loadComplianceStatusMap` and injected through `AudienceCtx`, and decide between:

- a precomputed per-person expiry map on the same seam, which handles the derivation in one place and matches how `complianceStatus` already works; or
- a relation date over `completionDate` with the boundary shifted by the certificate lifetime, which needs no precompute but pushes the derivation into the operator layer and will drift if the lifetime ever becomes configurable.

Pick one, say why in the code and in your report, and cover it with a test that pins a fixed clock and asserts a certificate expiring inside the window matches while one expiring outside it does not.

Also reconsider whether `hasServiceCredential` should distinguish a revoked credential from an absent one, and whether the remaining recruitment outcomes (rejected, interviewed, withdrew, applicant type) belong in this phase. Both were recorded as Part A gaps. Neither is required here; say what you recommend.

---

### Task B1: Editor shell

`src/app/(app)/outreach/campaigns/[id]/page.tsx` is a single long server component carrying eight inline server actions plus all the rendering. Splitting it is a precondition for everything else in Part B, and it is a pure refactor: no behavior changes.

**Files:**
- Create: `src/app/(app)/outreach/campaigns/[id]/actions.ts`
- Create: `src/app/(app)/outreach/campaigns/[id]/tabs.tsx`
- Modify: `src/app/(app)/outreach/campaigns/[id]/page.tsx`

**Interfaces:**
- Produces: every existing server action, moved to `actions.ts` as module-scope `"use server"` exports taking explicit serializable arguments. `assertScopeOrRedirect` moves with them and stays at module scope.
- Produces: `<EditorTabs active={...}>` client component driving Compose / Audience / Review, with the active tab in the URL (`?tab=audience`) so a save round-trip returns to the tab the sender was on.

- [ ] **Step 1: Inventory what must not change**

Before touching anything, write down every gate the current file enforces, and keep the list in the task report:

```bash
grep -n "requireAnyPermission\|requirePermission\|assertMayActOnScope\|assertScopeOrRedirect\|CampaignScopeError" \
  "src/app/(app)/outreach/campaigns/[id]/page.tsx"
```

Every one of those must still be present, on the same action, after the refactor. This inventory is the acceptance criterion for the task.

- [ ] **Step 2: Move the actions to module scope**

Create `actions.ts` with `"use server"` at the top of the file (not per-function), exporting each action. Each takes the ids it needs as explicit parameters rather than closing over render scope:

```ts
"use server";

/**
 * Campaign editor server actions.
 *
 * These live in their own module, at module scope, for a reason that is not
 * stylistic: a helper declared inside the page component and referenced from a
 * "use server" closure gets serialized as an encrypted bound argument, and a
 * function is not serializable. That compiles cleanly and then kills every
 * action on the page at runtime. It shipped once already.
 */
```

Keep `assertScopeOrRedirect` here too, with its existing `(personId, scopeId, id)` signature.

- [ ] **Step 3: Add the tab shell**

`tabs.tsx` is a small client component rendering three links that set `?tab=`, with the current tab highlighted. The page reads `searchParams.tab`, defaults to `compose`, and renders one section at a time. Redirects after a save should preserve the tab.

- [ ] **Step 4: Verify the refactor changed nothing**

```bash
npx tsc --noEmit
npx eslint src
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth \
  npx vitest run src/platform/email/
```

Then **render the page and exercise one action**, because no unit test covers the serialization failure this task is guarding against. Start the dev server with an explicit local database override, since this repo's `.env` points every `DATABASE_URL` at production Neon:

```bash
DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub \
DATABASE_URL_UNPOOLED=postgresql://haven:haven_dev@localhost:5434/havenhub \
  npm run dev
```

Load a campaign editor page and confirm the compose form's `action` attribute is a real action, not `javascript:throw new Error('React form unexpectedly submitted.')`. Save a subject change and confirm it persists. Stop the server. Put the observed `<form action=...>` value in your report.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/outreach/campaigns/[id]"
git commit -m "refactor(outreach): split the campaign editor into tabs and module-scope actions"
```

---

### Task B2: Searchable grouped field picker

Part A takes the field count past fifty. A flat `<select>` stops being usable well before that.

**Files:**
- Create: `src/app/(app)/outreach/campaigns/[id]/field-picker.tsx`
- Create: `src/app/(app)/outreach/campaigns/[id]/field-picker.test.tsx`
- Modify: `src/app/(app)/outreach/campaigns/[id]/audience-builder.tsx`

**Interfaces:**
- Produces: `<FieldPicker fields={PersonFieldView[]} value={string} onChange={(key: string) => void} />`

Behavior:
- A text input filters by field label and by group name, case-insensitively.
- Results stay grouped under their group heading; a group with no matches is hidden entirely.
- Keyboard: up/down move through matches, Enter selects, Escape closes and restores the previous value.
- The trigger shows the currently selected field's label, and its group as secondary text, so a stored condition remains readable without opening the picker.

- [ ] **Step 1: Write the failing component tests**

Cover, with Testing Library against the real `PERSON_FIELD_VIEWS`:

- typing a label substring narrows to matching fields;
- typing a GROUP name shows that group's fields (searching "Schedule" finds the shift-count fields even though none of their labels contain the word);
- a group with no matches does not render its heading;
- Enter selects the highlighted match and calls `onChange` with its key;
- Escape closes without calling `onChange`;
- a field key with no matching definition renders as a removable unknown rather than crashing, matching how the builder already handles stale stored values.

- [ ] **Step 2: Run to verify failure, implement, verify**

```bash
npx vitest run "src/app/(app)/outreach/campaigns/[id]/field-picker.test.tsx"
npx tsc --noEmit && npx eslint src
```

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/outreach/campaigns/[id]"
git commit -m "feat(outreach): add a searchable grouped field picker to the audience builder"
```

---

### Task B3: Date, number, and relative-window controls

Part A's date and count conditions currently have no way to be created from the UI. This task gives each operator the control it needs.

**Defects Part A left for this task. They are requirements here, not optional cleanup.**

Part A's final review escalated two of the three originally listed here into its own fix wave, because a date condition inside a NONE group turned out to match the ENTIRE Person table rather than failing safe. Those are **already done**; do not redo them:

- `defaultConditionFor` now has explicit `date`, `count`, and `year` branches, each with its reasoning in a comment, and `audience-builder.test.tsx` carries an invariant test asserting that for EVERY field in `PERSON_FIELD_VIEWS` the default operator is one that field declares. Extend that test if you add a kind; do not weaken it.
- The stale "no field of kind date is registered yet" comment is gone.

What remains for you:

1. **`OP_LABELS` is keyed by operator alone, not by field kind.** `lt` and `gt` read "is before" and "is after", right for a date and wrong for a count: a shift-count condition renders as "Shift count is before 3". Make label resolution aware of the field's kind.
2. **Absolute dates are validated as digit shapes, not real calendar dates.** `DATE_RE` is a four-two-two digit pattern, so `2026-02-30` passes and `Date.UTC` silently rolls it to March 2, shifting a boundary by up to three days and WIDENING `before` and `onOrBefore`. A native date input will not emit one, but a stored or hand-edited audience can. Close it with a round-trip check (reformat the parsed date and compare) so an impossible date matches nobody rather than a different day.
3. **The two condition kinds disagree on a reversed range.** `countWhere` returns match-nobody for a low bound above the high one; `dateWhere` returns a gte/lt pair, empty by range rather than by sentinel. Equivalent under ALL and ANY, different under NONE. Pick one representation while you are in the file.

**Files:**
- Create: `src/app/(app)/outreach/campaigns/[id]/value-controls.tsx`
- Create: `src/app/(app)/outreach/campaigns/[id]/value-controls.test.tsx`
- Modify: `src/app/(app)/outreach/campaigns/[id]/audience-builder.tsx`

**Interfaces:**
- Produces: `<ValueControl kind={PersonFieldKind} op={ConditionOp} value={AudienceCondition["value"]} onChange={(v) => void} zoneLabel={string} />`

Control per operator, and the value shape each must produce, which has to match exactly what Part A's operators parse:

| Kind | Operator | Control | Emits |
|---|---|---|---|
| date | before / after / onOrBefore / onOrAfter | one `<input type="date">` | `"YYYY-MM-DD"` |
| date | between | two date inputs | `["YYYY-MM-DD", "YYYY-MM-DD"]` |
| date | withinNextDays / withinLastDays | a number input with a "days" suffix | `"30"` |
| date | isEmpty / isNotEmpty | no control | `undefined` |
| count | eq / notEq / lt / lte / gt / gte | one number input, `min={0}`, `step={1}` | `"3"` |
| count | between | two number inputs | `["1", "3"]` |

Two requirements that are easy to miss:

- **Show the zone next to every absolute date control**, e.g. "Dates are read in Eastern (New York)". Part A resolves calendar days in the clinic's configured zone; a sender in another zone picking "March 20" otherwise has no way to know what that means. `zoneLabel` from `@/platform/dates` produces the string.
- **A relative window must reject negative and fractional input at the control**, not only in the compiler. Part A compiles those to match-nobody, which is safe but silently sends to no one; the control should stop it earlier and say why.
- **Absolute dates must be validated as real calendar dates, not just digit shapes.** Part A's `DATE_RE` is `/^\d{4}-\d{2}-\d{2}$/`, so `2026-02-30` passes and `Date.UTC` silently rolls it to March 2, shifting a boundary by up to three days and WIDENING `before` / `onOrBefore`. A native `<input type="date">` will not emit one, but a stored or hand-edited audience can. Close it with a round-trip check (reformat the parsed date and compare) so an impossible date matches nobody rather than a different day.
- **Make the two kinds agree on a reversed range.** `countWhere` returns match-nobody for `lo > hi`; `dateWhere` returns `{ gte, lt }`, which is empty by range rather than by sentinel. Equivalent under ALL and ANY, different under NONE. Pick one representation while you are in the file.

- [ ] **Step 1: Write the failing tests**

Cover each row of the table above, asserting the exact emitted value shape, plus: switching operator from `between` to `before` reduces a two-element value to a single string rather than leaving a stale array; switching from a date operator to `isEmpty` clears the value; a negative day count shows a validation message and does not call `onChange` with it.

- [ ] **Step 2: Run to verify failure, implement, wire into `ConditionRow`, verify**

The builder's existing `valueForOp` helper already handles operator changes reshaping a value; extend it rather than adding a parallel path.

```bash
npx vitest run "src/app/(app)/outreach/campaigns/[id]/"
npx tsc --noEmit && npx eslint src
```

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/outreach/campaigns/[id]"
git commit -m "feat(outreach): add date, count, and relative-window value controls"
```

---

### Task B4: Per-node live match counts

The property that makes a nested tree legible: every condition and every group reports how many people it matches on its own, so a sender can see which clause is doing the narrowing.

**Files:**
- Modify: `src/app/(app)/outreach/campaigns/[id]/actions.ts`
- Modify: `src/platform/email/campaigns/service.ts`
- Create: `src/app/(app)/outreach/campaigns/[id]/use-node-counts.ts`
- Modify: `src/app/(app)/outreach/campaigns/[id]/audience-builder.tsx`
- Modify: `src/platform/email/campaigns/service.test.ts`

**Interfaces:**
- Produces: `countAudienceNodes(campaignId: string, audience: Audience): Promise<Record<string, number>>` in the service, keyed by a stable node path (`"0"`, `"1.2"`, and `"root"`).
- Produces: `useNodeCounts(audience, action)` hook, debounced, cancelling in-flight requests when the tree changes again.

**The three properties this must have, in priority order:**

1. **Counts respect the campaign's scope.** Route every count through the same scope-aware resolution a real send uses, so a scoped sender's counts never include people they cannot mail. A count query that skipped the scope would leak the size and shape of other departments' rosters.
2. **One round trip, not one per node.** Walk the tree server-side and count each subtree in a single action call. A request per node turns a twelve-condition audience into twelve round trips on every keystroke.
3. **Debounced and cancellable.** Counting runs on every edit; without debounce it runs on every keystroke inside a text value.

- [ ] **Step 1: Write the failing service test**

```ts
  it("counts each node against the campaign's scope, not the whole roster", async () => {
    // A scope of ACTIVE-only, plus one OFFBOARDED person who satisfies the
    // campaign's own condition. The node count for that condition must NOT
    // include them: a preview that counts outside the scope leaks roster size.
  });

  it("returns a count for every node including nested groups and the root", async () => {
    // A root ALL with one condition and one nested ANY group of two conditions.
    // Expect keys: "root", "0", "1", "1.0", "1.1".
  });

  it("returns zero for an empty group rather than the whole roster", async () => {
    // compileGroup returns MATCH_NOBODY for an empty group; the count must
    // agree, not report everyone.
  });
```

- [ ] **Step 2: Implement `countAudienceNodes`**

Walk the tree, and for each node build a single-node `Audience` and resolve it through the existing scope-aware path. Count with `prisma.person.count` on the compiled where rather than materialising recipients, since only the number is needed.

Guard the cost: refuse to count a tree with more than, say, 40 nodes and return an empty map, so a pathological audience cannot fan out into dozens of queries per keystroke. State the limit in a comment with its reason.

- [ ] **Step 3: Wire the hook and render the counts**

Each condition row and group header shows its count as secondary text ("142 people"). While a request is in flight, show the previous count dimmed rather than a spinner, so the numbers do not flicker on every keystroke.

- [ ] **Step 4: Verify and commit**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth \
  npx vitest run src/platform/email/ "src/app/(app)/outreach/campaigns/[id]/"
npx tsc --noEmit && npx eslint src
git add -A
git commit -m "feat(outreach): show live per-node match counts in the audience builder"
```

---

### Task B5: Recipient preview and manual list UI

The right pane's payload: who, exactly, is about to be emailed, and the controls to nudge that list.

**Files:**
- Create: `src/app/(app)/outreach/campaigns/[id]/recipient-preview.tsx`
- Modify: `src/app/(app)/outreach/campaigns/[id]/actions.ts`
- Modify: `src/platform/email/campaigns/service.ts`
- Modify: `src/platform/email/campaigns/service.test.ts`

**Interfaces:**
- Produces: an extension to the existing `previewAudience` returning, per recipient, `{ personId, name, email, reason }` where `reason` names why they are in the list: `"matched"`, `"included"` (manual add), or `"pasted"`.

Behavior:
- A scrollable list of recipients with name and address.
- A per-row "exclude" control that appends to `excludePersonIds` (Part A Task 8).
- A search box to find and manually include a person, and a textarea to paste addresses.
- A count of people excluded for having no email address, which `resolveAudience` already returns as `excludedNoEmail` and which nothing currently surfaces.
- **Pasted addresses that resolve to nobody are listed back explicitly** rather than silently dropped, so a typo is visible instead of quietly shrinking the audience.

- [ ] **Step 1: Write the failing tests**

- the preview labels a manually included person `"included"` and a condition match `"matched"`;
- a pasted address outside the campaign's scope does NOT appear in the preview, matching what a real send would do (Part A Task 8's intersection);
- an unresolvable pasted address is reported back in a separate `unresolved` list;
- `excludedNoEmail` is surfaced.

- [ ] **Step 2: Implement, verify, commit**

```bash
TEST_DATABASE_URL=postgresql://haven:haven_dev@localhost:5434/havenhub_test_depth \
  npx vitest run src/platform/email/ "src/app/(app)/outreach/campaigns/[id]/"
npx tsc --noEmit && npx eslint src e2e
git add -A
git commit -m "feat(outreach): add a recipient preview with manual include and exclude"
```

---

### Final: end-to-end check

Part B changes the page every campaign is composed on, and the only test that drives it end to end is CI-only.

- [ ] Update `e2e/email-campaigns.spec.ts` for the tabbed layout, so the existing flow still passes through the new shell.
- [ ] Add one e2e case: open the Audience tab, add a date condition, confirm a per-node count renders, and confirm the recipient preview lists at least one person.
- [ ] Do NOT run Playwright locally. This repo's `.env` points every `DATABASE_URL` at production Neon, and a local run has polluted production before. Push and read the result from CI.

---

## Self-review notes

**Spec coverage.** Two-pane builder (B1), searchable picker (B2), the controls Part A's conditions need (B3), per-node counts (B4), recipient preview and manual list UI (B5), tabbed editor and action extraction (B1).

**Where the risk concentrates.** B1 is a refactor around authorization code that a Phase 1 review already caught a runtime-only bug in, which is why it carries an explicit gate inventory and a rendered-page check rather than trusting a green typecheck. B4 is the one place a preview could leak information across a scope boundary, so its first test is the scope test, not the correctness test.

**Ordering note.** B3 is the task that makes Part A usable at all. If Part B has to be cut short, B1 and B3 are the minimum that leave the phase coherent; B2, B4, and B5 are improvements to a builder that would already work without them.
