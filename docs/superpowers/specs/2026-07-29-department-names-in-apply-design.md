# Department names in the application (2026-07-29)

## Problem

The department preference dropdown on the public application offers only raw internal codes:
`VADM`, `MDIC`, `PATS`. No names, no descriptions. The only guidance is the sentence "See
department descriptions at havenfreeclinic.com/apply", which is plain text, not a link.

The department choice is the single most consequential answer in the application: it decides
which supplement questions appear, which committee reviews the applicant, and which department
they are routed to. It is currently made blind.

The raw code then reappears twice more, so the last chance to catch a wrong choice is also an
acronym:

- the review step renders "Department / position preference: MDIC"
- the generated section title renders "MDIC department questions"

Found and independently verified in the 2026-07-29 UX audit (PR #474) as finding R2 / F-04-1,
ranked 2nd of 88 items, reach "every applicant, once per cycle".

## Goals

An applicant can tell what they are choosing, at the moment they choose it and again when they
review it.

## Non-goals

- Writing department descriptions. The clinic's public site owns those; this makes the existing
  pointer a real link.
- Any change to how departments are configured, or to the form builder. Directors do not edit
  these options and will not start.
- The other 87 audit findings. R4, the other half of the audit's group G, ships separately.

## Design

### The audit's proposed fix, and why this deviates

The audit proposed loading `Department.name` and threading a code-to-name map through
`apply-wizard.tsx` into `field-preview.tsx`, `wizard-review.tsx`, and the step title.

A parallel map is unnecessary. Two consumers already resolve a code to a label through the
field's own `options`, and fall through to the raw code only because `options` is null:

- `src/app/apply/[slug]/wizard-review.tsx:26-28` does
  `f.options?.find((o) => o.value === one)?.label ?? one` for `DEPARTMENT_CHOICE`
- `src/modules/recruitment/engine/schema-builder.ts:116-120` treats `DEPARTMENT_CHOICE`
  identically to `SINGLE_SELECT`

So populate `options` instead of adding a second mechanism. The review step then needs no change
at all, and neither does the validator.

### 1. Inject options when the apply page loads the form

In `src/app/apply/[slug]/page.tsx`, load `Department` rows for the codes in `cycle.departments`
and inject `options: [{ value: code, label: name }]` into every `DEPARTMENT_CHOICE` field as the
form definition is built.

Order the options the way the cycle lists its departments, not alphabetically, so a director's
intended ordering survives. A code with no matching `Department` row keeps the code as its own
label, so an alias or a deleted department degrades to today's behavior rather than vanishing
from the dropdown.

**This is read-time only.** The `FormField.options` column stays null. The form builder is
untouched, which matters because `src/modules/recruitment/engine/field-types.ts:28` declares
`hasOptions: false` for this type: directors do not author these options, the cycle's department
list defines them.

### 2. Render the label in the dropdown

`src/modules/recruitment/components/field-preview.tsx` currently renders
`departments.map((d) => <option key={d} value={d}>{d}</option>)` for `DEPARTMENT_CHOICE`.

Render `f.options` when present, falling back to the existing `departments` behavior when absent.
The fallback is load-bearing: the same component renders the builder's live preview, where no
apply page has injected anything.

### 3. Make the descriptions pointer a link

`src/modules/recruitment/templates/field-groups.ts:82` sets the section description to the
literal "See department descriptions at havenfreeclinic.com/apply", rendered as plain text by
`src/platform/ui/form.tsx`, which types `description` as a `string`.

Make it a real anchor. Whether that means widening the `description` type to `ReactNode` or
adding a dedicated link affordance is an implementation choice; the requirement is that an
applicant can click it.

### 4. The generated step title

`src/modules/recruitment/templates/application/volunteer.ts:10` and `director.ts:10` both build
`title: \`${norm} department questions\``.

`src/modules/recruitment/templates/materialize.ts:7` writes that title into `FormSection` at
cycle creation, so **the code is already persisted in every existing cycle's rows**. Changing the
templates fixes only cycles created afterward.

Both halves are needed:

- **New cycles:** build the title from the department name.
- **Existing cycles:** substitute at render time, but **only when the stored title still equals
  the generated default for that section's `departmentCode`**. A director who renamed the section
  keeps their title untouched. This is precise and reversible; a backfill migration would rewrite
  rows we do not own and could not distinguish a default from a deliberate edit.

## Consequences worth stating

**~~Injecting options tightens server-side validation.~~ Retracted 2026-07-29: this was wrong.**

This section originally claimed that a `DEPARTMENT_CHOICE` answer was an unvalidated free string
today, and that injecting options would close that hole. It was verified false during Task 1 by
both the implementer and the reviewer, independently.

Server-side validation against `cycle.departments` has been enforced since commit `167c587f2`
(2026-06-08). `src/modules/recruitment/services/submissions.ts`, in `toSectionDefs`, self-supplies
options for `DEPARTMENT_CHOICE` from `cycle.departments` regardless of what `FormField.options`
holds, so `schema-builder` has always built a `z.enum` on that path.

The `def` object built in `page.tsx` is passed only to the client wizard for display.
`submitApplication` independently reloads the cycle and builds its own section definitions, so
this change never reaches the validation path. **No validation behavior ships with this change.**

The tests written for the retracted claim were kept anyway, and correctly labeled in
`submissions.test.ts` as pinning pre-existing behavior rather than guarding new logic. Pinning a
real invariant is worth doing; misattributing it would not have been.

The error is recorded rather than deleted because it shaped the plan: Task 1 Step 6 exists
because of it.

**A cycle whose `departments` list contains an unknown code still works.** The option renders
with the code as its label and validation accepts it, because it is present in the options list.

## Testing

- Options are injected for `DEPARTMENT_CHOICE` fields, in the cycle's department order, with
  names resolved and unknown codes falling back to the code.
- The review step renders the name. This should pass without touching `wizard-review.tsx`, which
  is the point of the approach; if it needs a change, the approach was wrong.
- **The validation change:** a submission whose department code is not in the cycle's list is now
  rejected, and one whose code is in the list is accepted. This is the consequence above, pinned.
- The builder preview still renders departments when no options are injected.
- Step title: a new cycle materializes the name; an existing cycle's default title renders the
  name at display time; a director-customized title is left alone.

## Risks

- **The step-title substitution is the fragile part.** It matches a stored string against a
  generated pattern. If the pattern in the templates changes later without updating the matcher,
  existing cycles silently stop being fixed. The matcher and the generator should live next to
  each other, and the test should assert they agree.
- **Department names are longer than codes** and appear in a dropdown, a review row, and a step
  title. Nothing here is width-constrained in a way that worries me, but it is the kind of change
  that looks fine at desktop width and wraps badly on a phone, which this audit could not check.
