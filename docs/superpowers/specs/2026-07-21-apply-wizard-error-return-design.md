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

A third problem was considered and dropped: the inline message next to the offending field
was once a terse internal tag (`"duplicate choice"`, `"max 3"`). Commit `6aef367e`
("fix(recruitment): show readable field errors instead of internal codes", PR #345) already
replaced these with a `fieldProblem(fieldKey, message)` helper that puts the readable
sentence in both the banner and the field slot. No work remains there.

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

The `catch` branch around the submit call also clears `errorStepIndex`. A thrown server
action (signature storage, DB failure) blames no field, so a stale index left over from an
earlier field-error submit would pin that banner to a step the applicant is not on.

## Files

| File | Change |
| --- | --- |
| `src/app/apply/[slug]/apply-wizard.tsx` | `editStep` on bounce; `errorStepIndex` state, render guard, clear-on-leave, clear-on-throw |

## Testing

**Neither change has automated coverage.** This repo has no jsdom or React Testing Library
configuration, so the wizard has no component tests. The only automated coverage is
`e2e/apply-portal.spec.ts`, which requires Neon and cannot run locally, and is not a
required check.

Both were instead verified by driving the running app (dev server on a throwaway local
Postgres, seeded with a 7-step OPEN cycle whose step 3 carries a `SUBCOMMITTEE_RANK`
field). Observed:

- Submitting with the same subcommittee ranked 1st and 2nd bounces to step 3 of 7,
  "Department preference", with the banner and the inline "Each subcommittee can be ranked
  only once." both present.
- Walking every step with the error outstanding shows the banner on step 3 and on no other
  step. Before the change it rendered on all seven.
- Correcting the 2nd choice and pressing Continue once goes straight from step 3 to step 7,
  the review. Previously this took four presses.
- Resubmitting the corrected application reaches "Application received", so the bounce path
  does not leave the form in a state that blocks a valid submit.

Typecheck (`npx tsc --noEmit`) and the full repo lint (`npm run lint`) both pass.

## Out of scope

- Client-side pre-validation of ranking uniqueness before submit. That would prevent this
  particular round trip, but the bounce-back path still has to work for every rule the
  client cannot check (duplicate application, closed cycle, server-side file rules).
- Any change to `stepIndexForKeys`, which already resolves the correct step and is tested.
- Multi-step errors. `stepIndexForKeys` returns the first matching step; an applicant with
  errors on two steps fixes the first, returns to Review, and bounces again to the second.
  Acceptable, and unchanged by this work.
