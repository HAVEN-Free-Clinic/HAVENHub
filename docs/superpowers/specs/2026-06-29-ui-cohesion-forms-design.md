# UI Cohesion, Phase 1: Forms

Date: 2026-06-29
Status: Design (awaiting review)
Part of: App-wide UI cohesion initiative (4 phases, see Roadmap below)

## Problem

HAVEN Hub already has a solid primitive set in `src/platform/ui/` (`Card`, `Field`/`Input`/`Textarea`, `Select`, `Checkbox`, `Combobox`, `Button`/`SubmitButton`, `Alert`, `Badge`, `Modal`, `Table`, `PageHeader`). The tokens are coherent (controls `rounded-lg`, surfaces `rounded-2xl`, semantic color variables, two canonical focus-ring patterns). The issue is **drift and under-adoption**, not a missing system.

For forms specifically, an audit found three coexisting styles:

1. Primitive-heavy (~42%): admin, my-info. Uses `Field` + `Input`. Already close to ideal.
2. Minimal inline (~23%): sign-in, settings, search forms. No `Field`, hand-rolled labels (`text-sm` instead of the standard `text-xs`).
3. Custom fieldset/helper (~35%): onboard, apply, recruitment public. Custom `field()` / `FieldPreview` helpers, hand-rolled checkboxes and radios.

The trigger for this work, the My Info "Profile" form, shows the visible symptom: read-only rows use `rounded-xl` filled boxes (`rounded-xl border bg-muted`) sitting in the same row as `rounded-lg` white inputs (two shapes per row), and the whole form floats on the page canvas with no container.

## Goal

Standardize **every** form in the app onto one canonical pattern so forms feel cohesive module to module, and the read-only/editable mismatch is gone. Migrate all forms in a single Phase 1 PR (user decision: one PR, mostly mechanical).

## Non-goals (handled by later phases)

- Migrating non-form hand-rolled `Card` divs (Phase 2)
- Page headers and section-heading consolidation (Phase 3)
- Non-form raw buttons, focus-ring audit, lint guardrail (Phase 4)

This phase touches surfaces/buttons only where they are part of a form being migrated.

## Roadmap (the full initiative)

1. **Phase 1, Forms (this spec):** one canonical form pattern + supporting primitives + migrate all forms.
2. **Phase 2, Surfaces/Cards:** migrate ~58 hand-rolled card divs to `<Card>`, define padding presets, fix wrong-radius card-likes.
3. **Phase 3, Page structure:** `<PageHeader>` everywhere, one `SectionHeader` component, standard content width and vertical rhythm.
4. **Phase 4, Controls + guardrails:** non-form raw buttons, unify focus rings, add lint rule + house-style doc.

Each later phase gets its own spec, plan, and PR.

## The canonical form pattern

Chosen direction (visual brainstorm option B): forms live in a `<Card>` panel, read-only fields render as static display rows.

Rules:

1. **Container.** A primary create/edit form is wrapped in `<Card>` (existing primitive: `rounded-2xl border border-border bg-surface shadow-sm`, `p-5`). The page-level uppercase section label (e.g. "Profile") stays above the card.
2. **Read-only fields.** Rendered with the new `ReadonlyField`: `xs` muted label, value as `text-sm font-medium text-foreground`, a thin bottom hairline (`border-b border-border`), and an optional hint (e.g. "Contact IT to change"). No filled boxes, no `rounded-xl`.
3. **Editable fields.** Always wrapped in `Field` (existing) with `Input` / `Select` / `Textarea` / `Checkbox` / `Radio`. Label style is the `Field` default: `text-xs font-medium text-muted-foreground`. No more `text-sm` ad-hoc labels.
4. **Layout.** `grid gap-4 sm:grid-cols-2` for multi-field forms, single column on mobile, `space-y-6` between groups. Read-only identity fields group above editable fields.
5. **Footer.** Actions live in `FormActions` (new, thin wrapper): consistent top padding and gap, holds `SubmitButton` (+ optional secondary). `Alert` (error/success) renders at the top of the card.
6. **Grouping.** Long forms that genuinely mix locked and editable fields (My Info) may use `FormSection` to add a labeled divider between groups. Default is no dividers.

### Carding rule

- **Carded:** primary create/edit forms (person, department, term, subcommittee, my-info, onboard, apply, settings entries, recruitment builders, epic request, etc.).
- **Inline (not carded), but still uses primitives:** small utilities, search/filter boxes, single-field actions, and the dev-login box. Carding a one-field search would read as heavier, not more cohesive. These still migrate off raw `<input>`/`<button>` to `Input`/`Field`/`Button`.

## New and changed primitives

All in `src/platform/ui/`. Each mirrors the existing token conventions (radii, `border-border-strong`, brand focus ring).

### New: `ReadonlyField` (in `input.tsx`, beside `Field`)
Static display row for IT-managed / non-editable values.
- Markup: `div.flex.flex-col.gap-1` > `span` label (`text-xs font-medium text-muted-foreground`) + `p` value (`text-sm font-medium text-foreground py-1.5 border-b border-border`, min height to align with inputs) + optional hint (`text-xs text-subtle-foreground`).
- Empty state: italic "Not set" in `text-subtle-foreground`.
- Props: `{ label: string; value: ReactNode; hint?: string }`.

### New: `Radio` and `RadioGroup` (new file `radio.tsx`)
There is no radio primitive today; apply-form and quiz options hand-roll them.
- `Radio`: `label.flex.items-center.gap-2.text-sm` wrapping `input[type=radio]` with `h-4 w-4 border-border-strong text-brand accent-brand` + the button focus ring (`focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand`), matching `Checkbox`.
- `RadioGroup`: `div[role=radiogroup].flex.flex-col.gap-2` with optional legend (`text-xs font-medium text-muted-foreground`).

### New: `FormSection` (new file `form.tsx`)
One consolidated fieldset + legend, replacing the divergent `field()` / `FieldPreview` / fieldset blocks in onboard, apply, recruitment public.
- `fieldset` (reset border/padding) with optional `legend` (`text-xs font-semibold uppercase tracking-wider text-muted-foreground`) and optional description, plus `space-y-4` body.

### New: `FormActions` (new file `form.tsx`, beside `FormSection`)
Standard footer for form buttons.
- `div.flex.items-center.gap-3.pt-2`, optional `justify-end`.

File placement summary: `ReadonlyField` in `input.tsx` (beside `Field`); `Radio`/`RadioGroup` in new `radio.tsx`; `FormSection`/`FormActions` in new `form.tsx`.

### Changed: none of the existing primitives change their public API.
`Field`, `Input`, `Select`, `Textarea`, `Checkbox`, `SubmitButton`, `Alert` keep their current signatures. `training-quiz.tsx`'s local `fieldInputClass` is deleted in favor of `Input`/`Select`/`Textarea`.

## Migration scope and inventory

Source of truth greps (run 2026-06-29). Three working lists:

### A. Forms to convert to the canonical carded pattern (primary edit/create)
Representative, by module:
- my-info: `my-info-form.tsx` (read-only rows to `ReadonlyField`), `epic-panel.tsx`, `hipaa-panel.tsx`, `certificate-viewer.tsx`
- admin: `person-form.tsx`, `department-form.tsx`, `term-form.tsx`, `subcommittee-form.tsx`, `assignment-form.tsx`, `delegation-editor.tsx`, `clinic-dates-editor.tsx`, `roles-panel.tsx`, `roster-panel.tsx`, `person-memberships-panel.tsx`, `epic-request-form.tsx`, `ticket-number-field.tsx`
- admin pages: `admin/settings/page.tsx` (+ `branding-image-field.tsx`), `admin/people/[id]/page.tsx`, `admin/terms/[id]/page.tsx`, `admin/notifications/page.tsx`, `admin/email/*` (`page.tsx`, `campaigns/new`, `campaigns/[id]` + `audience-builder.tsx`, `templates/[key]`)
- recruitment: `cycles/[id]/page.tsx`, `cycles/new/page.tsx`, `builder/*` (`field-card.tsx`, `section-card.tsx`, `options-editor.tsx`, `quiz/quiz-builder.tsx`), `onboarding/page.tsx`, `training/page.tsx`, `subcommittees/page.tsx`, `decisions/page.tsx`, `applicants/[applicationId]/page.tsx`, `interviews/[interviewId]/page.tsx` + `add-panelist-form.tsx`
- learning: `manage/page.tsx`, `manage/[courseId]/page.tsx` + `UploadPackageForm.tsx`, `dashboard/page.tsx`
- schedule: `attending-form.tsx`, `capacity-panel.tsx`, `pending-requests.tsx`, `readiness-panel.tsx`, `builder/page.tsx` (form parts only; builder-cell buttons are Phase 4)
- volunteers: `disciplinary/page.tsx`, `epic/page.tsx` (+ `select-all-checkbox.tsx`), `master/page.tsx`, `offboarding/page.tsx`, `spanish-review/page.tsx`, `page.tsx`
- public/auth: `apply/[slug]/apply-form.tsx`, `apply/sign-in-form.tsx`, `onboard/[token]/onboard-form.tsx`, `login/page.tsx` (dev box stays inline but uses primitives), `get-started/page.tsx`, `welcome/page.tsx`

### B. Hand-rolled checkbox/radio to replace with `Checkbox` / `Radio`
`audience-builder.tsx`, `UploadPackageForm.tsx`, `options-editor.tsx`, `schedule/builder/page.tsx`, `schedule/page.tsx`, `training-quiz.tsx`, `select-all-checkbox.tsx`, `apply-form.tsx`, `onboard-form.tsx`, `epic-request-form.tsx`, `attending-form.tsx`.

### C. Raw `<input>`/`<select>`/`<textarea>` to route through `Input`/`Select`/`Textarea` (+ `Field`)
The Part 3 grep list (minus the primitives themselves: `input.tsx`, `select.tsx`, `checkbox.tsx`, `combobox.tsx`). Highest-divergence: `training-quiz.tsx` (custom `fieldInputClass`), `login/page.tsx` (dev box), `ticket-number-field.tsx`, the volunteers/* search-and-filter pages.

### Explicitly excluded from Phase 1 (these `<form>` hits are infra, not user forms)
`platform/ui/app-shell.tsx`, `platform/ui/combobox.tsx`, `platform/ui/submit-button.tsx`.

## Accessibility and dark mode

- `Field` keeps its implicit label association (label wraps the control), so screen readers and label-click focus keep working without threading `id`/`htmlFor`.
- `RadioGroup` uses `role=radiogroup`; each `Radio` keeps a real `input[type=radio]` with shared `name`.
- `ReadonlyField` is non-interactive text, not a disabled input, so it is not a tab stop and reads as static content.
- All classes use semantic tokens (`text-foreground`, `border-border`, `bg-surface`), which already flip under the dark theme. Verify the read-only hairline and card contrast in dark mode.

## Testing and verification

- Add light render tests for the new primitives (`ReadonlyField`, `Radio`/`RadioGroup`, `FormSection`, `FormActions`) following the existing `*.test.ts` style in `platform/ui/`.
- Keep all existing form submission behavior identical: server actions, `name` attributes, and `defaultValue`s are unchanged. This migration is presentational. Confirm no `name`/action wiring changes by diff review.
- Run the recruitment Playwright specs that exercise `apply-form` (the portal-cookie suite) to confirm the public application form still submits after migration.
- Verification gate before claiming done: typecheck, lint, `next build`, the vitest suite, and a manual visual pass on My Info, person-form, settings, onboard, and apply in both light and dark themes.
- Test DB note: per project convention, run vitest with a per-worktree `TEST_DATABASE_URL`; never point Prisma migrate/test at the shared Neon DB.

## Risks and mitigations

- **Wide visual diff across many forms.** Mitigation: presentational-only changes, one canonical pattern, manual visual pass on the flagships plus spot checks per module.
- **Behavioral regression in server actions.** Mitigation: do not touch `name`/`action`/validation; review the diff for any control whose `name` or `defaultValue` changed.
- **Read-only/editable height misalignment in mixed grids.** Mitigation: group read-only fields separately from editable ones (the convention), and give `ReadonlyField` a min-height tuned to the input height.
- **Dark-mode contrast on new static rows.** Mitigation: semantic tokens + explicit dark-theme visual check.

## Open questions

None blocking. Sectioning (`FormSection` dividers) is opt-in per form; default is the flat carded layout.
