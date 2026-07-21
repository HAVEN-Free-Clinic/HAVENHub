# Apply wizard: returning from a server validation error

## Problem

When a public application fails server-side validation on submit, the wizard sends the
applicant back to the step that owns the offending field. From there the experience
degrades in two ways:

1. **Continue walks forward one step at a time.** After the bounce-back the applicant must
   press Continue through every remaining step to reach Review again. On an 11-step form
   an error in step 5 costs six extra clicks through steps they already completed.
2. **The error banner follows them.** The page-level `Alert` renders above the step body,
   outside the step-conditional content, so a stale submit failure is displayed on every
   step until the next successful submit.

A third, smaller problem surfaced while scoping: the inline message rendered next to the
offending field is a terse internal tag (`"duplicate choice"`, `"unknown choice"`,
`"max 3"`) rather than a sentence. The readable text exists only in the banner, which is
precisely the element that is about to be scoped away from most steps.

## Current behavior

`src/app/apply/[slug]/apply-wizard.tsx`, in `onSubmit`:

```js
const res = await submitPublicApplication(def.slug, fd);
if (!res.ok && res.fieldErrors) {
  setFieldErrors(res.fieldErrors);
  const idx = stepIndexForKeys(steps, Object.keys(res.fieldErrors));
  if (idx != null) goTo(idx);
}
setResult(res);
```

`goTo` moves the step pointer and focuses the heading. It does not set `editingReturn`, so
`handleNext` falls through to `target = stepIndex + 1`.

The wizard already has the right mechanism. `editStep(index)`, used by the Review page's
Edit links, sets `editingReturn = true`, and `handleNext` then computes
`target = reviewIndex`. The server-bounce path simply never uses it.

## Design

### 1. Bounce-back returns to Review in one click

Replace `goTo(idx)` with `editStep(idx)` in `onSubmit`. Fix the field, press Continue once,
land back on Review. The left progress rail continues to reach any other step directly, so
nothing becomes unreachable.

This makes a server validation bounce behave identically to an Edit click from Review,
which is the same shape of interaction: jump out to correct one answer, come straight back.

### 2. Banner pinned to the step that owns the error

Add `errorStepIndex: number | null` state.

- Submit fails with field errors resolving to a step: `setErrorStepIndex(idx)`.
- Submit fails with no resolvable field step (duplicate application, cycle closed, a
  signature blob-storage throw): `setErrorStepIndex(null)`. A null index means "show
  wherever the applicant is", which is Review, matching today's behavior for those cases.

Render guard:

```js
{result && !result.ok && (errorStepIndex === null || stepIndex === errorStepIndex) && (
  <Alert tone="error">{result.message}</Alert>
)}
```

In `handleNext`, once the current section passes local required-field validation, clear
`result` and `errorStepIndex` if the applicant is leaving the error step. Without this a
later visit back to an already-corrected step would resurrect a stale banner.

### 3. Readable inline field messages

`src/modules/recruitment/services/submissions.ts` throws single-field
`SubmissionValidationError`s that put a terse tag in the field slot:

```js
throw new SubmissionValidationError(
  "Each subcommittee can be ranked only once.",
  { [fieldKey]: "duplicate choice" },
);
```

Pass the same sentence to both slots. Eight throw sites: the four in `resolveRanking`
(required, duplicate, over-cap, unknown), plus missing file, unexpected upload, invalid
signature, and `renewalDepartment`.

The zod path already does this correctly, putting `issue.message` in the field slot and a
generic "Please fix the highlighted fields." in the banner. It is untouched.

Net effect: the field carries a full sentence at the point of correction, and the banner
reinforces it on that step only.

## Files

| File | Change |
| --- | --- |
| `src/app/apply/[slug]/apply-wizard.tsx` | `editStep` on bounce; `errorStepIndex` state, render guard, clear-on-leave |
| `src/modules/recruitment/services/submissions.ts` | Readable sentence into the field slot at eight throw sites |
| `src/modules/recruitment/services/submissions.test.ts` | Assert the field-slot message for the ranking cases |

## Testing

**Change 3 is unit-testable.** Add assertions to `submissions.test.ts` covering the four
`resolveRanking` outcomes. Existing tests there assert key presence
(`toHaveProperty("1st_choice_department")`) rather than tag values, so they do not break.
The one test asserting a specific message (`fieldErrors.availability`, line 911) comes
through the zod path and is unaffected.

**Changes 1 and 2 have no local test coverage.** This repo has no jsdom or React Testing
Library configuration, so the wizard has no component tests. The only automated coverage is
`e2e/apply-portal.spec.ts`, which requires Neon and cannot run locally, and is not a
required check. These two changes will be verified by driving the running app: submit an
application with a deliberate duplicate subcommittee ranking, confirm the bounce lands on
the owning step, that Continue returns directly to Review, and that the banner does not
appear on any other step.

## Out of scope

- Client-side pre-validation of ranking uniqueness before submit. That would prevent this
  particular round trip, but the bounce-back path still has to work for every rule the
  client cannot check (duplicate application, closed cycle, server-side file rules).
- Any change to `stepIndexForKeys`, which already resolves the correct step and is tested.
- Multi-step errors. `stepIndexForKeys` returns the first matching step; an applicant with
  errors on two steps fixes the first, returns to Review, and bounces again to the second.
  Acceptable, and unchanged by this work.
