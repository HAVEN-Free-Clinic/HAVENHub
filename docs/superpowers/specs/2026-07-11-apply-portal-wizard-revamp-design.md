# Apply Portal + Application Wizard Revamp — Design

Date: 2026-07-11
Status: Approved for planning
Area: Public application portal (`/apply`, `apply.havenfreeclinic.org`)

## Summary

Revamp the public application portal and the application pages themselves so they
read as a real, polished "application portal." Two things change together:

1. **Structure.** The single long scrolling application form becomes a guided
   multi-step wizard (one step per section), and the signed-in home becomes a
   place applicants return to and track their applications from.
2. **Visuals.** Every portal surface is redesigned in an "elevated institutional"
   style: official and trustworthy, generous whitespace, crisp type, subtle
   brand accents, restrained color.

The server actions, validation, visibility engine, and status data source are
unchanged. This is a front-of-house redesign plus a client-side wizard shell over
the existing form machine.

## Context: current state

- `src/app/apply/page.tsx` — portal home. Logged out: a glass sign-in card over a
  brand backdrop. Logged in: a flat "Your applications" list (one line per app) +
  an "Open applications" list, inside `PortalShell`.
- `src/app/apply/[slug]/page.tsx` — server component. Loads the cycle, its
  `APPLICATION` sections/fields, renewal context, and any draft; builds a `def`;
  renders `PortalShell` + `ApplyForm`.
- `src/app/apply/[slug]/apply-form.tsx` — one client `<form>` (~275 lines) doing a
  lot: applicant-type radio, conditional section visibility (`isSectionVisible`),
  debounced autosave (`saveDraftAction`), immediate file upload
  (`uploadDraftFileAction`), and submit (`submitPublicApplication`).
- `src/app/apply/portal-shell.tsx` — masthead frame (thin brand rule + HAVEN
  lockup + centered `max-w-2xl` column).
- `src/app/apply/portal-notice.tsx` — branded terminal/empty states.
- `src/modules/recruitment/services/portal-status.ts` — `getApplicantStatus`
  returns per-application `state` in `DRAFT | SUBMITTED | INTERVIEW | ACCEPTED |
  ONBOARDING | NOT_SELECTED | WAITLISTED`, already privacy-careful (final outcomes
  only after `decisionsReleasedAt`; internal evaluations never read).
- `src/modules/recruitment/components/field-preview.tsx` — renders each field
  **uncontrolled** (`name={key}`, `defaultValue`/`defaultChecked` from prefill,
  `required`). Values are read from the form via `FormData`.

Key implication of the uncontrolled-field model: the wizard can keep all visible
step fields mounted and simply show one step at a time. Autosave, file uploads,
prefill, locked/read-only fields, and the final `FormData` submit keep working
without change.

## Decisions (from brainstorming)

- **Scope:** both structure and visuals, the full portal treatment.
- **Tone:** elevated institutional. Yale-blue used sparingly as accent, whitespace,
  crisp type, subtle shadows/thin rules, no flashy color.
- **Flow:** one step per section. Steps: an optional "Getting started" step
  (applicant type + renewal department, only when the cycle accepts renewals),
  then each visible section, then a "Review & submit" step. Steps recompute live
  as conditional sections appear/disappear.
- **Status tracker:** a discreet 4-stage tracker per submitted application
  (Submitted, In review, Interview, Decision) with one neutral line of context.
  Deliberately not over-disclosing: no leaning, no internal state, decisions only
  after official release. Onboarding surfaces only once someone is accepted.

Visual references: three approved mockups were produced during brainstorming
(`wizard-step`, `landing-status`, `review-step`). They live as local, uncommitted
artifacts in the primary checkout under
`.superpowers/brainstorm/20229-1783783060/content/` and approximate the real
design tokens; the implementation uses the actual token system.

## Goals

- The application is a guided, one-section-per-step wizard with a persistent
  progress rail, per-step validation, back/edit navigation, and a review step.
- The signed-in home is a portal: welcome hero, draft continuation, discreet
  per-application status tracking, and open applications to start.
- Every surface is visually elevated and consistent, light and dark, accessible.
- No regression in autosave, drafts, file upload, renewal/transfer, conditional
  sections, or submission.

## Non-goals

- No change to server actions, the visibility engine, draft/renewal services,
  auth, cycle/window gating, or the status data source.
- No new heavy dependencies (motion is CSS-only).
- No rebuild of the logged-out sign-in card; only a light polish so it matches the
  masthead/brand-rule system.
- No per-application detail page and no disclosure of internal evaluation state.

## Architecture

### Wizard mechanics (chosen approach)

One `<form>`. All currently **visible** step sections are mounted; only the current
step is shown (the others are visually hidden but remain in the DOM so their
values stay in `FormData`). Non-visible sections (wrong applicant type / department)
are not mounted, exactly as today.

- Autosave stays: the form's `onChange` still serializes the whole form via
  `FormData` and calls `saveDraftAction`.
- File uploads stay: `FILE` fields still upload immediately via
  `uploadDraftFileAction`; the wizard does not touch that path.
- Submit stays: the final step submits the same `FormData` to
  `submitPublicApplication`.
- The final submit already uses a JS `onSubmit` handler (native validation is not
  relied upon), so hidden mounted fields do not trigger native validity focus
  problems.

Rejected alternatives: controlled React state for every field (large rewrite of
`FieldPreview` + upload/prefill/locked paths, high regression risk); render-only-
current-step with mirrored hidden inputs (fiddly, error-prone).

### Files

New / changed under `src/app/apply/[slug]/`:

- `apply-wizard.tsx` (new; replaces `apply-form.tsx`) — client orchestrator. Owns
  step index, applicant-type/renewal/department state, autosave, per-step
  validation, submit, and the review snapshot. Renders `WizardProgress`, the
  current section card (via existing `FieldPreview`), and `WizardReview` on the
  last step.
- `wizard-progress.tsx` (new) — presentational. Desktop: vertical step rail with
  named steps and completed checkmarks. Mobile: compact "Step X of N" header with
  a slim progress bar and the current step name. Completed steps are
  back-navigable buttons; future steps are inert.
- `wizard-review.tsx` (new) — presentational. Renders the review snapshot grouped
  by section with a per-section Edit control that jumps to that step.
- `use-wizard-steps.ts` (new) — pure helper. Given `def`, `applicantType`,
  `deptChoice`, `renewalDept`, and `acceptsRenewals`, returns the ordered step
  list (`{ kind: "intro" | "section" | "review", id, title }`). Unit-testable.
- `apply-form.tsx` — deleted.

New / changed under `src/app/apply/`:

- `page.tsx` — signed-in view refactored to hero + "Your applications" (status and
  draft cards) + "Open applications". Logged-out view unchanged apart from light
  polish.
- `application-tracker.tsx` (new) — presentational, server-compatible. Renders the
  4-node discreet tracker from a mapped stage.
- `status-card.tsx` (new) — one application's card: title, submitted date, status
  pill, tracker, and one neutral context line; or the draft variant with Continue.

Shared:

- `portal-shell.tsx` — add `width?: "prose" | "wide"` (default `prose` =
  `max-w-2xl`; `wide` = `max-w-4xl` for the wizard two-column layout). Masthead,
  brand rule, and org-name resolution unchanged.
- `src/modules/recruitment/services/portal-tracker.ts` (new) — pure
  `trackerStageFor(state)` returning `{ index, nodes }` describing which of
  [Submitted, In review, Interview, Decision] are done / current / upcoming, plus
  a terminal flag for accepted/onboarding/waitlisted/not-selected. Unit-tested.
  `portal-status.ts` remains the data source and is not changed.

### Step derivation

`use-wizard-steps.ts` returns, in order:

1. `intro` — only when `def.acceptsRenewals`. Carries the applicant-type radio
   (New / Renewing / Transferring, filtered by eligibility) and the renewal
   department control.
2. `section` (one per entry in the live `visible` list) — the same
   `isSectionVisible` result used today, driven by `applicantType` and
   `selectedDepartmentCodes`.
3. `review` — always last.

Steps are keyed by a stable id (`"intro"`, the section id, `"review"`) so that when
the visible set changes (applicant type or department choice), the wizard keeps
pointing at the same logical step where possible and clamps otherwise. Entering the
`RENEWAL`-but-not-signed-in gate keeps the intro step and blocks Continue behind the
existing "Sign in with Yale" prompt.

### Per-step validation

On Continue, validate only the current step's fields against their field defs
(required-ness first; the server remains the authority on format). Empty required
fields get inline errors (reusing the `fieldError` prop `FieldPreview` already
supports) and Continue is blocked, focusing the first invalid field. The intro
step validates applicant type / renewal department. The review step performs no new
validation; it submits.

On a server `fieldErrors` response at submit, map each errored key to the step that
contains it, navigate to the earliest such step, and surface the errors there.

### Review snapshot

When the applicant reaches the review step, snapshot the form's current values
(via `FormData`) into a display model: for each visible section, list its fields as
label/value pairs, mapping option values to their labels and files to their file
name. Editing a section sets the step index back to that section; returning to
review re-snapshots.

### Layout, responsive, accessibility

- Desktop wizard: two columns (rail + card) inside `PortalShell width="wide"`.
  Mobile: single column, rail replaced by the compact progress header.
- Progress is a `<nav aria-label="Application progress">`. The current step has
  `aria-current="step"`. Completed steps are buttons; future steps are inert until
  reached. On step change, focus moves to the step heading (`tabIndex={-1}`).
- The autosave status keeps its `aria-live="polite"` region.
- Tokens only (brand, surface, canvas, foreground, muted, border, critical,
  success); light and dark; no hardcoded colors; no tailwind-merge. Motion is CSS
  transitions only and respects reduced motion. Copy contains no em-dashes.

### Discreet tracker mapping

`trackerStageFor(state)`:

- `SUBMITTED` → Submitted done, In review current, Interview/Decision upcoming.
- `INTERVIEW` → Submitted + In review done, Interview current, Decision upcoming.
- `ACCEPTED` / `ONBOARDING` → all four done, terminal = accepted (card shows the
  accepted/onboarding treatment and detail from `getApplicantStatus`).
- `WAITLISTED` → Submitted + In review + Interview done, Decision current/terminal,
  neutral copy.
- `NOT_SELECTED` → Decision terminal, neutral thank-you copy.
- `DRAFT` → no tracker; the draft card with Continue.

Context lines are calm and non-disclosing (for example, In review reads "We're
reviewing applications now. You'll get an email when there's an update, nothing
needed from you."). Interview detail (time, "join link in your email") and accepted
department come straight from the existing status view.

## Testing

- Unit (vitest):
  - `portal-tracker.test.ts` — every `state` maps to the expected node states and
    terminal flag.
  - `use-wizard-steps` tests — new/renewal/transfer step lists, conditional
    department sections appearing/disappearing, `acceptsRenewals = false` (no intro
    step), stable-id behavior when the visible set changes.
  - Per-step validation helper — required-field detection per step.
- E2e (Playwright): update the `/apply` flow in `e2e/recruitment.spec.ts` (and any
  sibling spec that submits an application) to walk the wizard: advance with
  Continue, exercise back/edit, hit the validation block on a missing required
  field, reach Review, and Submit. Keep field selectors stable so only navigation
  steps are added.
- Manual verification: run the app, drive a real cycle through New, Renewal, and
  Transfer, confirm autosave/resume, file upload, conditional department sections,
  submission, and the landing tracker across states, in light and dark.

## Rollout / sequencing

1. Extract pure helpers first (`use-wizard-steps.ts`, `portal-tracker.ts`) with
   unit tests.
2. Build `wizard-progress.tsx`, `wizard-review.tsx`, `application-tracker.tsx`,
   `status-card.tsx` as presentational pieces.
3. Refactor `apply-form.tsx` into `apply-wizard.tsx` wiring the pieces together,
   preserving autosave/upload/submit.
4. Add `PortalShell width` and refactor `page.tsx` landing.
5. Light polish on the logged-out sign-in card for consistency.
6. Update e2e specs; run unit + e2e; manual verification.

## Open questions

None blocking. Copy for tracker context lines and the review confirmation will be
finalized during implementation and kept non-disclosing and em-dash-free.
