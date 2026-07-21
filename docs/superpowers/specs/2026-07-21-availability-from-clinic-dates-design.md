# Availability options from the term's clinic dates

Date: 2026-07-21
Status: approved, ready for implementation planning

## Problem

The recruitment application's availability question does not read the admin's
clinic calendar. It computes its own.

Admins curate the real calendar at `/admin/terms/[id]` into `Term.clinicDates`
(`prisma/schema.prisma:245`), a noon-UTC anchored `DateTime[]` with add, remove,
and regenerate-Saturdays controls. The application form instead calls
`termSaturdays(term.startDate, term.endDate)`
(`src/modules/recruitment/templates/term-dates.ts:3`), which returns every
Saturday between term start and end.

The two lists diverge in both directions:

- Saturdays the admin removed (breaks, holidays) are still offered to applicants.
- Clinic dates that are not Saturdays are never offered at all.

This is not cosmetic. The answer flows through `parseAvailabilityDates`
(`src/modules/recruitment/services/promotion.ts:19`) into
`TermMembership.baselineAvailability`, which is tier 3 of the scheduler's
availability resolution. Phantom dates enter the scheduler's data.

A second defect compounds it: `materializeTemplate`
(`src/modules/recruitment/templates/materialize.ts:14`) snapshots the option
list into `FormField.options` at cycle creation, and nothing ever re-syncs it.
Cycles are typically created before the clinic calendar is finalized, so even a
correct source would go stale.

## Decisions

1. **Live, not snapshotted.** Options resolve from `Term.clinicDates` at load
   time. The stored `FormField.options` snapshot is ignored for this field.
2. **Recruitment application only.** Onboarding collects no structured
   availability today (the onboarding contract has no availability field; the
   training intake has free-text `Training.additionalShiftAvailability` plus a
   `minShiftsWanted` select). Converting those is out of scope.
3. **Empty calendar hides the question.** No clinic calendar means the dates are
   genuinely unknown, so the question is not asked and its required-ness is not
   enforced. The applicant is never blocked.
4. **All of the term's clinic dates are offered**, with no filtering of dates
   already past. The option list stays stable for the life of the cycle.

Approach A of three considered: a shared pure resolver called by each loader.
Rejected: a single choke-point loader (real surgery across four sites that
differ in their includes and `purpose` filters, for a guarantee a test also
buys), and a first-class `CLINIC_DATES` field type (needs a Prisma migration
plus conversion of existing `MULTI_SELECT` fields, reintroducing the migration
this approach avoids).

Approach A is the only option that retroactively fixes cycles already seeded
with phantom Saturdays, because it ignores their stored snapshot.

## Design

### New module: `src/modules/recruitment/templates/clinic-dates.ts`

Two pure functions.

```ts
clinicDateOptions(clinicDates: Date[]): TemplateOption[]
```

Sorted ascending. `value` is `isoDateKey(d)`, the `YYYY-MM-DD` UTC day key that
`parseAvailabilityDates` already expects and that the scheduler compares on.
`label` is `formatCalendarDate(d, { weekday: "short", month: "short", day: "numeric" })`,
rendering as "Sat, Jun 6".

Both helpers come from `@/platform/dates`, which is platform code and so carries
no module-boundary violation from recruitment. The weekday is newly included
because clinic dates are no longer guaranteed to fall on Saturdays, which makes
the weekday load-bearing information rather than noise.

Anchoring note: `Term.clinicDates` entries are noon-UTC; `isoDateKey` reads the
UTC day, so there is no off-by-one. Baseline availability is written at UTC
midnight and compared by day key, so the two anchors reconcile.

```ts
resolveAvailabilityOptions(sections, clinicDates): sections
```

Locates fields keyed `"availability"`.

- Non-empty calendar: replaces that field's `options` with `clinicDateOptions(clinicDates)`.
- Empty calendar: removes the field. Removes its containing section only if that
  leaves the section with zero fields, so a director who added their own fields
  to the Availability section does not lose them.
- All other sections and fields pass through untouched. A cycle with no
  availability field is a no-op.

### Wiring

Four loaders read a cycle's form. Each adds `term: { select: { clinicDates: true } }`
to its include and pipes sections through the resolver:

| Site | Purpose |
| --- | --- |
| `src/app/apply/[slug]/page.tsx:18` | applicant render |
| `src/modules/recruitment/services/drafts.ts:57` | draft restore |
| `src/modules/recruitment/services/submissions.ts:95` | validate and submit |
| `src/modules/recruitment/services/cycles.ts:98` (`getCycle`) | form builder and ApplyPreview |

Resolution reads the cycle's own term via `cycle.termId`, never
`getActiveTerm()`. Recruitment cycles routinely run against a `PLANNING` term
ahead of the manual term flip, so an active-term read would show the wrong
calendar in precisely the case this feature exists to serve.

Because both the render path and the validation path resolve from the same
function, the offered options and the accepted options cannot drift.

### Seeding

`createCycle` (`src/modules/recruitment/services/cycles.ts:51`) swaps
`termSaturdays(term.startDate, term.endDate)` for
`clinicDateOptions(term.clinicDates)`. Live resolution overrides the snapshot in
any case; this keeps the stored data honest rather than misleading.

`src/modules/recruitment/templates/term-dates.ts` is deleted; `createCycle` is
its only caller and it has no test of its own. The admin-side `saturdaysBetween`
(`src/modules/admin/services/terms.ts:53`) is a separate function, is untouched,
and remains the source for the admin's regenerate-Saturdays control.

### Submit tolerance

`MULTI_SELECT` validates as a strict zod enum over the field's options
(`src/modules/recruitment/engine/schema-builder.ts:106`). With a live list, an
admin editing clinic dates between a saved draft and its submission would
hard-reject the submit over a checkbox that is no longer rendered, leaving the
applicant with no way to fix it.

Availability values absent from the live option set are therefore discarded
before validation rather than rejected. If every selection is discarded on a
required field, the applicant gets the ordinary "required" error against the
refreshed list, which is recoverable.

### Builder read-only

The availability field's options render read-only in the cycle form builder,
with a line pointing at the term's clinic dates. Without this, a director can
edit options that are silently ignored.

### Promotion hardening

`promoteContracts` filters parsed availability against the term's clinic dates
before writing `baselineAvailability`. Applications already submitted carry
phantom Saturdays today, and without this filter they still reach the scheduler
after this change ships. This also means a date the admin removes after
submission does not linger in anyone's availability.

## Data flow

```
admin edits Term.clinicDates (/admin/terms/[id])
  -> resolveAvailabilityOptions at each of the 4 loaders (keyed on cycle.termId)
  -> applicant checkboxes on the apply wizard
  -> Application.answers.availability : YYYY-MM-DD[]
  -> parseAvailabilityDates, filtered to the term's clinic dates
  -> TermMembership.baselineAvailability (UTC midnight)
  -> scheduler tier 3, compared by UTC day key
```

Tiers 1 and 2 (`directorAvailabilityDates`, `selfAvailabilityDates`) are
untouched.

## Testing

Unit, `clinicDateOptions`: noon-UTC input yields the correct day key with no
off-by-one; ascending sort; weekday-bearing label.

Unit, `resolveAvailabilityOptions`: replaces options on the availability field;
empty calendar removes the field; empty calendar removes the section only when
it would otherwise be left with no fields; unrelated sections and fields are
untouched; a cycle with no availability field is a no-op.

Integration: each of the four loaders returns live options. This is the guard
against a fifth loader being added later without resolution, which is the known
weakness of this approach.

Submit: a value removed from the calendar mid-flight is discarded rather than
fatal; an empty calendar does not block submission on a required availability
field.

Promotion: a phantom date on an already-submitted application is filtered out of
`baselineAvailability`.

Updates to existing tests: the `createCycle` seeding tests, which currently
exercise the term start/end window rather than a clinic calendar. Note that
`templates/field-groups.test.ts:37` and `templates/index.test.ts` need no change:
`availabilitySection(dates)` and `getApplicationTemplate(track, departments, dates)`
keep their signatures, since the change is in what gets passed to them and when.

## Risks

The binding between the form and the scheduler is the literal field key
`"availability"`. This coupling is pre-existing
(`src/modules/recruitment/services/promotion.ts:65`) and this design does not
deepen it, but a director renaming that key in the builder would silently break
both resolution and promotion. Out of scope here; worth a guard later.

A fifth form loader added in future could omit resolution. Mitigated by the
integration test above, not by the type system. The choke-point loader
(approach B) was the alternative that would have made this structurally
impossible.
