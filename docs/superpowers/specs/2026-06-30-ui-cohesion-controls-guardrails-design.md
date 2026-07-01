# UI Cohesion, Phase 4: Controls + Guardrails (capstone)

Date: 2026-06-30
Status: Design (awaiting review)
Part of: App-wide UI cohesion initiative (4 phases). Phases 1-2 merged; Phase 3 (page chrome) on PR #173. This is the capstone.

## Problem

Phases 1-3 standardized forms, surfaces, and page chrome. Four loose ends remain, plus there is no automated guard against re-introducing the drift the initiative removed:

1. **Focus-ring divergence.** `builder-cell.tsx` (3 grid-cell buttons) uses `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-fg`; the schedule date-pill checkboxes use `focus:ring-brand focus:ring-1`. Both differ from the two canonical patterns (button/checkbox/radio: `focus-visible:outline-2 outline-offset-2 outline-brand`; form controls: `focus-visible:border-brand ring-2 ring-brand/15`).
2. **Hardcoded card strings.** `StatCard` and `Table` still inline `rounded-2xl border border-border bg-surface ... shadow-sm` instead of `cardClasses()` (the last two duplications of that string after Phase 2).
3. **SectionHeader h2-only flattening.** From Phase 3: `SectionHeader` renders only `<h2>`, so eyebrows/sub-labels nested under a section `<h2>` (hipaa/epic panels, schedule sub-labels) became sibling `<h2>`s, flattening those outlines.
4. **`training-quiz` local `Field`.** A bespoke local `Field` (with `optional`/`full` grid-span props) still shadows the platform `Field`.
5. **Cosmetic:** ~5 admin forms where Phase 2 inserted `<Card>` but left children at the old indent level.

And: nothing stops a future contributor from hand-rolling a styled `<button>`/`<input>` again.

## Goal

Add an automated guardrail (ESLint rule + house-style doc) so hand-rolled controls are caught going forward, then resolve the four loose ends so the rule passes cleanly. One capstone PR.

## Non-goals

- Re-migrating forms / surfaces / headers (Phases 1-3).
- A lint rule for hand-rolled SURFACES (`rounded-2xl bg-surface` divs): not cleanly expressible in `no-restricted-syntax` (it is a className-substring pattern, not an element). Covered by the house-style doc instead.
- Changing genuinely specialized raw controls into primitives where that would be wrong (editor toolbar toggles, tabs, drag handles, segmented toggles, native file inputs). These stay raw and get annotated.

## The design

### 1. ESLint guardrail (`eslint.config.mjs`)

The config is flat (extends `eslint-config-next` core-web-vitals + typescript) and already uses scoped `files`/`rules` blocks. Add:

```js
{
  files: ["src/app/**/*.tsx", "src/modules/**/*.tsx"],
  rules: {
    "no-restricted-syntax": ["error", {
      selector: "JSXOpeningElement[name.name=/^(button|input|select|textarea)$/] > JSXAttribute[name.name='className']",
      message: "Use the shared UI primitives (Button/Input/Select/Textarea/Checkbox/Radio from @/platform/ui) instead of a styled raw control. If a raw element is genuinely required (toolbar toggle, tab, drag handle, segmented toggle, native file input, grid-cell button), add an eslint-disable-next-line no-restricted-syntax with a one-line reason.",
    }],
  },
}
```

- Scoped to `src/app` + `src/modules`; `src/platform/ui/**` is NOT matched (its primitives legitimately render styled raw controls), so no override needed.
- Errors on any raw `<button>/<input>/<select>/<textarea>` carrying a `className`. `<input type="hidden">` (no className) does not trip it.
- The implementer must confirm the esquery selector matches in this ESLint version (the `JSXOpeningElement > JSXAttribute` child form is robust; if the version mis-parses it, fall back to four explicit element selectors). A negative check (add a styled raw `<button>`, confirm lint errors, remove it) is part of verification.

### 2. The sweep (forced by the rule)

`npx eslint .` after adding the rule produces the authoritative violation list. For each violation, either:
- **Convert** to a primitive when it is a plain action control (a styled `<button>` that is really a Button -> `<Button variant=...>`).
- **Annotate** when the raw element is genuinely required: `// eslint-disable-next-line no-restricted-syntax -- <one-line reason>` immediately above it.

Rough shape (authoritative list comes from the rule): ~33 raw `<button>`s across ~15 files (the 14 in `admin/email/templates/[key]/preview.tsx` are an editor toolbar; plus tabs in `epic-request-tabs`, segmented toggles in `audience-builder`, drag handles + add buttons in the recruitment builder, the 3 `builder-cell` grid buttons); 5 native file inputs (`UploadPackageForm`, `branding-image-field`, `onboard-form`, `hipaa-panel`, `field-preview`); no raw `<select>`/`<textarea>` remain. The pill checkboxes are handled in item 3 (converted, not annotated).

### 3. Focus-ring unification

- `builder-cell.tsx` 3 buttons: replace `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-fg` with the canonical `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand`. They stay raw grid-cell controls, so each also gets the `eslint-disable-next-line` + reason ("grid-cell action button, not a standard Button").
- Schedule date-pill checkboxes (`schedule/page.tsx`, `schedule/builder/page.tsx`): convert the inner `<input type="checkbox" className="... focus:ring-brand ...">` to `<Checkbox className="h-3 w-3">`, keeping the pill `<label>` wrapper and the `name`/`value`/`defaultChecked`/`checked`/`onChange` wiring. This fixes the focus ring AND removes the raw control (no annotation needed).

### 4. `StatCard` + `Table` -> `cardClasses`

- `stat-card.tsx`: replace the inline `base = "block rounded-2xl border border-border bg-surface p-5 shadow-sm"` with `cx("block", cardClasses({ interactive: <linked> }))`, keeping its existing focus-visible outline on the linked variant. Visual output unchanged.
- `table.tsx`: replace `<div className="rounded-2xl border border-border bg-surface overflow-x-auto shadow-sm">` with `<div className={cx(cardClasses({ pad: false }), "overflow-x-auto")}>`.

### 5. `SectionHeader` h3 variant

Add an optional `as` prop (default `h2`):

```tsx
export function SectionHeader({ level = "eyebrow", as: Tag = "h2", className, children }: {
  level?: "eyebrow" | "title"; as?: "h2" | "h3"; className?: string; children: ReactNode;
}) {
  return <Tag className={cx(levelClasses[level], className)}>{children}</Tag>;
}
```

Apply `as="h3"` to the section sub-labels that Phase 3 flattened into sibling `<h2>`s: `hipaa-panel.tsx`, `epic-panel.tsx` sub-headings, and the schedule `pending-requests.tsx` / `readiness-panel.tsx` sub-labels that sit under a section `<h2>`. Restores proper `h2 > h3` nesting. Add a `section-header.test.ts` case for `as="h3"`.

### 6. `training-quiz` local `Field` convergence

Replace `training-quiz.tsx`'s local `Field` with the platform `Field` (from `@/platform/ui/input`). Its `optional` marker becomes a `hint` (or omitted), and its `full` grid-span becomes a `className` (e.g. `sm:col-span-2`) on the field wrapper, rather than extending the platform `Field` API for a single caller. The controls inside are already the canonical `Input`/`Select`/`Textarea` (Phase 1 sweep). Remove the now-unused local `Field`.

### 7. Card-child reindent (cosmetic)

In the ~5 admin forms where Phase 2 inserted `<Card>` but kept children at the prior indent (`person-form`, `department-form`, `term-form`, `subcommittee-form`, `delegation-editor`), reindent so children sit one level inside the Card and the closing `</Card>` aligns with the opening. Run the project formatter if one is configured; otherwise reindent by hand. No semantic change.

### 8. House-style doc (`docs/ui-house-style.md`)

A durable reference: the primitive catalog (Button/Input/Select/Textarea/Checkbox/Radio; Card + cardClasses; Field/ReadonlyField/FormSection/FormActions; SectionHeader/PageHeader; Alert/Badge/Modal/Table/StatCard), the canonical tokens (control radius `rounded-lg` + `border-border-strong`; surface radius `rounded-2xl`/compact `rounded-xl`; the two focus-ring patterns; semantic-tokens-only; no em-dashes; "HAVEN Hub" naming), when a raw control is acceptable, and the `eslint-disable-next-line no-restricted-syntax -- reason` convention enforced by the rule.

## Testing and verification

- `section-header.test.ts`: add an `as="h3"` case (renders h3, keeps the level classes). Existing `card.test.ts` and `section-header.test.ts` still pass; `StatCard`/`Table` refactors are output-equivalent (spot-check class strings).
- ESLint: `npm run lint` must pass GREEN after the sweep (rule + all conversions/annotations done). Plus a negative check: temporarily add a styled raw `<button className="...">` in an app file, confirm `eslint` errors on it, remove it.
- `npx tsc --noEmit` and `next build` (compile) gate the branch; same stale-Prisma-client caveat (this branch sits on the merged-main state; CI regenerates). New tests touch no DB.
- Presentational/behavioral preservation: control `name`/`value`/`onClick`/`defaultChecked` and focus behavior preserved; the pill-checkbox conversion keeps the same submitted values.
- Deferred to QA (needs a running app): a focus-visible keyboard pass on builder-cell + the pill checkboxes; a light/dark glance; an axe heading-order pass confirming the `as="h3"` nesting reads correctly.

## Risks and mitigations

- **esquery selector portability:** the rule may not match if the ESLint version parses the selector differently. Mitigation: the negative check verifies the rule fires; fall back to four explicit element selectors if needed.
- **Sweep is large** (~38+ raw controls): mitigated by doing it module-by-module, with the rule's own output as the checklist, and the lint-green gate proving completeness.
- **Over-annotation:** annotating a control that should really be a `<Button>`. Mitigation: convert plain action buttons; annotate only genuinely specialized controls, each with a specific reason (review checks the reasons).
- **Stale shared Prisma client:** local `tsc` shows pre-existing stale-client errors; CI regenerates. Do not `prisma generate` in the worktree.

## Branch and PR

- Branch `feat/ui-cohesion-controls-guardrails`, stacked on `feat/ui-cohesion-page-chrome` (Phase 3, #173). PR base set to that branch; GitHub auto-retargets to `main` when #173 merges (or base `main` directly if #173 merges first).

## Open questions

None blocking. The lint rule covers controls only; surfaces are doc-covered (per non-goals).
