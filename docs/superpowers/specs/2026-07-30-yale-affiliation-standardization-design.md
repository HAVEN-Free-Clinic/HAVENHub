# Yale affiliation standardization

Date: 2026-07-30

## Problem

`Person.yaleAffiliation` is a nullable free-form `String` written by four
surfaces that do not agree on a vocabulary, and read by four consumers that
each pattern-match the resulting mixture by hand.

Writers today:

| Surface | Widget | Vocabulary |
| --- | --- | --- |
| `/apply` recruitment form (`yale_affiliation` template question) | dropdown | 13 canonical machine keys (`yale_college`, `ysm_md`, `staff`, `other_yale`, `non_yale`, ...) |
| Onboarding contract system field `yaleAffiliation` | dropdown via `systemFieldOptions()` | the same 13 keys, plus any unrecognized stored value prepended so re-saving cannot erase it |
| `/my-info` and `/get-started/profile` (`MyInfoForm`) | dropdown | a separate hand-written list of 8 human strings |
| `/admin/people/new` and `/admin/people/[id]` (`PersonForm`) | free-text `<Input>` | anything an admin types |
| Airtable import (`transforms.ts`) | n/a | raw Airtable strings (`"Yale Staff"`, `"Other Yale Affiliation"`) |

Readers today:

- `src/platform/ehs/engine/applicability.ts:22` keeps a hand-maintained
  lowercase superset of all three vocabularies to decide student versus
  clinical bloodborne-pathogen training.
- `src/modules/support/services/itcm-pdf.ts:259` matches the literal labels
  `"Yale Staff"` and `"Other Yale Affiliation"`, then falls back to
  `affiliation.toLowerCase().includes("med")`.
- `src/platform/email/audience/person-fields.ts:143` exposes it as a free-text
  campaign filter, so ops type raw strings against whichever vocabulary
  happened to be written.
- Onboarding contract `visibleWhen: { field: "yaleAffiliation", op: "is", value: "staff" }`
  gates the staff-title question on the machine key.

Two live bugs fall out of this:

1. A person stored with the canonical key `ysm_md` matches neither the
   `"Yale Staff"` branch nor `includes("med")` in the Epic PDF, so the YNHH
   form is stamped Student -> "Other" with the literal text `ysm_md`.
2. `isStudentAffiliation()` excludes only staff/other/blank, so someone who
   picked "I am NOT a Yale Affiliate" (`non_yale`) reads as a student and is
   assigned student BBP instead of clinical BBP.

## Decisions

Confirmed with Jack before design:

1. **Canonical list**: the existing recruitment 13. It is the most granular
   (splits YSM MD from YSM PA, names GSAS/SOM/YLS/Jackson/Divinity), it is
   already what `/apply` and the onboarding contract write, and contract
   `visibleWhen` rules already key on `staff`. The 8-string `MyInfoForm` list
   is deleted.
2. **Legacy data**: backfill what we recognize, leave what we do not. No value
   is ever nulled. Unmapped values keep rendering through the prepend path.
3. **EHS**: `non_yale` becomes a non-student, so those people get clinical BBP.
4. **Epic PDF**: `ysm_md` and `ysm_pa` check the Med Student box. Every other
   school checks the Student row's "Other" with its label written in.
   `staff`, `other_yale`, and `non_yale` check the Job Title row's "Other".
5. **In scope**: converting the email audience filter to an enum picker, and
   normalizing Airtable imports.
6. **Out of scope**: adding a conditional "please specify" text box to
   `MyInfoForm` / `PersonForm`. `Person.staffTitle` already captures that via
   onboarding, and it would widen a cleanup into a new feature.

## Architecture

### The canonical module must live in `src/platform/`

This is forced by the lint boundary, not a stylistic preference.
`eslint.config.mjs` enforces two rules that matter here:

- Modules may not import each other. `my-info` and `admin` are both in
  `MODULE_IDS`, so neither may import `modules/recruitment`.
- `src/platform/**` may not import module code at all.

The canonical list currently lives in
`src/modules/recruitment/templates/content/options.ts`, which is precisely why
`MyInfoForm` grew a parallel hand-written copy in the first place. After this
change the consumers are `platform/ehs`, `platform/email/audience`,
`platform/airtable`, `modules/my-info`, `modules/admin`, and `modules/support`,
all of which sit on the wrong side of that boundary.

`src/platform/people.ts` already set this precedent, and its header states the
reason explicitly: it lives in platform "so that both the admin module and the
member-facing my-info module can drive person mutations without one module
importing another".

### New file: `src/platform/affiliation.ts`

Self-contained, no DB access, fully unit-testable.

```ts
export type AffiliationOption = { value: string; label: string };

/** The 13 canonical options, moved verbatim from recruitment. */
export const YALE_AFFILIATIONS: AffiliationOption[];

/** Canonical label, the raw string when unrecognized, "" when null. */
export function affiliationLabel(value: string | null | undefined): string;

/** The 13, prepending an unrecognized stored value as its own option. */
export function affiliationOptionsWith(current: string | null | undefined): AffiliationOption[];

/** Legacy string -> canonical key, case- and whitespace-insensitive.
 *  Null, undefined, and whitespace-only inputs return null. Any other
 *  string with no mapping is returned trimmed but otherwise unchanged. */
export function normalizeAffiliation(raw: string | null | undefined): string | null;

/** Moved from platform/ehs/engine/applicability.ts. */
export function isStudentAffiliation(value: string | null | undefined): boolean;

/** ysm_md | ysm_pa. */
export function isMedicalSchoolAffiliation(value: string | null | undefined): boolean;
```

`affiliationOptionsWith` generalizes the prepend rule that
`systemFieldOptions()` implements today, so all four forms behave identically
and there is exactly one implementation of "never silently erase a stored value
we do not recognize".

`isStudentAffiliation` moves here because student-ness is a property of the
affiliation, not of EHS. `isMedicalSchoolAffiliation` stays generic: the YNHH
checkbox ids stay in the support module, so no YNHH form knowledge leaks into
platform.

### Re-export shims

Two shims keep existing importers unchanged, matching the pattern
`system-fields.ts` already uses for `defaultContractLayout`:

- `src/modules/recruitment/templates/content/options.ts` re-exports
  `YALE_AFFILIATION` from platform. `TemplateOption` is
  `{ label: string; value: string }` and `AffiliationOption` is
  `{ value: string; label: string }`, structurally identical and mutually
  assignable, so no cast is needed.
- `src/platform/ehs/engine/applicability.ts` re-exports
  `isStudentAffiliation` for its two callers in `ehs/services/`.

## Components

### Forms

**`src/modules/my-info/components/my-info-form.tsx`** (covers `/my-info` and
`/get-started/profile`): delete the local `YALE_AFFILIATIONS` array at lines
19-28 and the `isKnownAffiliation` check at 53-56. Render
`affiliationOptionsWith(person.yaleAffiliation)` behind the existing
`<option value="">Not set</option>`. The prepend now comes from the shared
helper instead of the inline conditional at lines 114-116.

**`src/modules/admin/components/person-form.tsx`** lines 96-102: the free-text
`<Input>` becomes the same `<Select>`, with the same "Not set" blank leading
option since the column is nullable. Both `/admin/people/new` and
`/admin/people/[id]` inherit it, and their server actions already coerce
`(formData.get("yaleAffiliation") as string) || null`, so neither changes.

**`/apply` and the onboarding contract** change only by import path.
`systemFieldOptions()` in `src/modules/recruitment/contract/system-fields.ts`
delegates its prepend branch to `affiliationOptionsWith`.

Side effect worth naming: onboarding contract prefill
(`src/app/onboard/[token]/contract-field.tsx:226`) already assumes stable
machine keys, so people whose affiliation was written by `/my-info` currently
prefill as a stray non-canonical option. The backfill fixes that for free.

### Backfill migration

A data-only Prisma migration. No schema change, so `prisma migrate dev
--create-only` plus hand-written SQL, and there is no prior drift to fold in or
trim.

The `UPDATE` maps `lower(trim("yaleAffiliation"))` to canonical keys and is
idempotent (values already canonical map to themselves). Rows matching nothing
are left untouched.

Known legacy vocabularies to cover:

- The `MyInfoForm` 8: `"Yale College"` -> `yale_college`,
  `"Yale School of Medicine"` -> `ysm_md`,
  `"Yale School of Nursing"` -> `ysn`,
  `"Yale School of Public Health"` -> `ysph`,
  `"Physician Associate Program"` -> `ysm_pa`,
  `"Graduate School"` -> `gsas`, `"Staff"` -> `staff`, `"Other"` -> `other_yale`.
- The canonical labels, which is the form Airtable and the recruitment
  application's own labels take: `"Yale Staff"` -> `staff`,
  `"Other Yale Affiliation"` -> `other_yale`,
  `"Yale School of Divinity"` -> `divinity`, `"Yale Law School (YLS)"` -> `law`,
  and so on for each of the 13.

`"Yale School of Medicine"` is the one genuinely ambiguous mapping. Within the
`MyInfoForm` vocabulary it means MD, because that list carries
`"Physician Associate Program"` as a separate option. A free-typed or imported
`"Yale School of Medicine"` could be either. It maps to `ysm_md` and any
correction is a hand fix.

**Sequencing gate**: the mapping table is authored against real data, not
guessed. Before the migration is written, run against prod (read-only):

```sql
SELECT "yaleAffiliation", count(*)
FROM "Person"
WHERE "yaleAffiliation" IS NOT NULL
GROUP BY 1
ORDER BY 2 DESC;
```

The four vocabularies found in code are a floor, not a ceiling. Admins have had
a free-text box, so the real distribution is the only reliable source for what
the mapping needs to cover. Any value the query surfaces that the mapping does
not handle is either added to the mapping or accepted as a hand fix, explicitly.

### Consumers

**EHS** (`src/platform/ehs/engine/applicability.ts:22`): the non-student set
becomes the canonical keys `staff`, `other_yale`, `non_yale`, plus the retained
lowercase legacy forms (`"yale staff"`, `"other yale affiliation"`, `"other"`)
for values the backfill could not map. Blank stays non-student. Adding
`non_yale` is the BBP misassignment fix.

**Epic PDF** (`src/modules/support/services/itcm-pdf.ts:258-275`): the
`"Yale Staff"` literal match and the `includes("med")` substring hack both go.

| Condition | Checkbox | Text field |
| --- | --- | --- |
| `isMedicalSchoolAffiliation(a)` | `Check Box45` (Student > Med Student) | none |
| `isStudentAffiliation(a)` | `Check Box48` (Student > Other) | `Text30` = `affiliationLabel(a)` |
| otherwise, and `a` is non-empty | `Check Box21` (Job Title > Other) | `Text29` = `affiliationLabel(a)` |

Both text fields now receive `affiliationLabel(a)` rather than the raw column,
so YNHH sees "Yale School of Nursing (YSN)" instead of `ysn`. The existing
`isBulk` guard and the empty-affiliation no-op are unchanged.

**Email audience** (`src/platform/email/audience/person-fields.ts:143`):
`textField("yaleAffiliation", ...)` becomes an `enum` field with
`options: YALE_AFFILIATIONS`, `operators: ["eq"]`, and the `MATCH_NOBODY`-on-blank
guard the `status` field already uses. Without that guard a blank value
compiles to `{ yaleAffiliation: undefined }`, which Prisma drops, matching
everyone.

**Airtable import** (`src/platform/airtable/import/transforms.ts:70`): wrap the
extracted value in `normalizeAffiliation()` so imports cannot re-pollute the
column after the backfill. Unmatched strings pass through verbatim.

## Error handling

The design's failure mode is data loss on a value we do not recognize, and
every layer refuses it:

- `normalizeAffiliation` returns its input unchanged rather than null when
  there is no mapping.
- The migration's `UPDATE` touches only rows that match the mapping.
- `affiliationOptionsWith` prepends an unrecognized stored value so re-saving a
  form cannot erase it.
- `affiliationLabel` falls back to the raw string, so an unmapped value renders
  as itself rather than blank.
- `isStudentAffiliation` keeps its legacy lowercase forms so an unmapped
  non-student is not reclassified into the wrong BBP training.

The email audience field is the one place that deliberately does not tolerate
unknown values: a campaign filter offering free text against machine keys is
worse than one that offers only the 13, and `MATCH_NOBODY` makes a blank
selection fail closed.

## Testing

New `src/platform/affiliation.test.ts`:

- `normalizeAffiliation` over every legacy string, with case and surrounding
  whitespace variants, plus passthrough of an unmapped string and null.
- `affiliationLabel` for a canonical key, an unmapped legacy string, and null.
- `affiliationOptionsWith` prepends exactly once for an unmapped value and not
  at all for a canonical one or for null.
- `isStudentAffiliation` across all 13 keys, the legacy lowercase forms, and
  blank. Explicitly asserts `non_yale` is false.
- `isMedicalSchoolAffiliation` is true for exactly `ysm_md` and `ysm_pa`.

Updated:

- `src/platform/ehs/engine/applicability.test.ts` for the `non_yale` flip.
- `src/modules/support/services/itcm-pdf.test.ts` for the three-row mapping
  driven by canonical keys, asserting the label is written rather than the key.
- `src/platform/email/audience/person-fields.test.ts` for the enum compile and
  the blank match-nobody guard.
- `src/platform/airtable/import/transforms.test.ts` for normalized imports and
  verbatim passthrough of an unknown string.
- `src/modules/recruitment/contract/system-fields.test.ts` if the re-export
  changes the observed shape.

No e2e coverage touches the affiliation field (verified by grep over `e2e/`),
so the visible label changes in `MyInfoForm` carry no e2e-breakage risk.

Before pushing: `npm run lint` over the whole repo, since typecheck and tests
do not catch the eslint import-boundary rules that this design turns on.
