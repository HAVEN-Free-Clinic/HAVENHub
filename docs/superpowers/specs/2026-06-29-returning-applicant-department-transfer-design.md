# Returning applicants can transfer to a new department

**Date:** 2026-06-29
**Branch:** `feat/returning-applicant-transfer`
**Issue:** returning applicants are currently locked to renewing in their current department; this lets them come back into a different department.

## Problem

Today a returning applicant must be a `RENEWAL`, and a renewal is hard-locked to a department the person already belongs to. The server throws "You can only renew in a department you currently belong to." (`src/modules/recruitment/services/submissions.ts`), and the apply form only ever offers the person's own current departments.

A returning member who wants to come back into a *different* department has no path. They either renew in place or apply from scratch as if they were a stranger, losing the "we know this person" signal.

## Goal

Let any active returning member apply to come back into a department they are not currently in, while:

- giving them the full new-applicant form for that department (the new department's leads do not know them, so they answer the normal newcomer questions), and
- keeping a clear, distinct marker so reviewers can tell a returning transfer apart from a true newcomer and from a same-department renewal.

## Decisions (locked with the user)

1. **Experience:** a transfer fills out the full NEW-applicant form for the target department (not the lighter renewal form).
2. **Eligibility:** any active member of the cycle's track may transfer, even if their current department is not part of this cycle. (Today, renewal eligibility additionally requires that a current department be offered by this cycle; transfer eligibility does not.)
3. **Marker:** a distinct applicant type, surfaced wherever applicant type appears.
4. **Nudge to renew:** a transfer may not target a department the person already belongs to. Choosing a current department nudges them to the Renew path instead (UI inline note plus server-side rejection).
5. **Wording:** "Renew / Renewing" is reserved for the current-department path. The new path uses "Transfer / Transferring". Apply options read "New applicant" / "Renewing in my current department" / "Transferring to a new department". The new type's admin label is "Transfer".

## Chosen approach

Add a third `ApplicantType` value, `TRANSFER`. Do **not** add it to `ApplicantScope`, so admins never have to re-tag form sections. Instead the form-visibility engine maps a `TRANSFER` applicant onto the `NEW` scope, so a transfer sees exactly the new-applicant questions. The target department flows through the existing department-choice field, just like a new applicant. Promotion is unchanged.

Approaches rejected:

- Adding `TRANSFER` to `ApplicantScope` as well, to allow transfer-only questions. More form-builder surface and a second enum migration, with no requirement for transfer-specific questions. YAGNI.
- Reusing `RENEWAL` with a "switching" flag. Contradicts the distinct-type decision and forces `RENEWAL` applicants to sometimes see `NEW` sections, muddying the scoping rule.

## Design

### 1. Data model (`prisma/schema.prisma`)

- Add `TRANSFER` to the `ApplicantType` enum (`NEW`, `RENEWAL`, `TRANSFER`). Leave `ApplicantScope` unchanged.
- Add `transferFromDepartments String[] @default([])` to `Application`. This is a snapshot of the person's active department codes at submission time, so reviewers can see "previously SRHD" even if the person is later offboarded. `renewalDepartment` stays `null` for transfers; the target department(s) live in the existing `departmentChoices`.
- One Prisma migration covering the enum value addition and the new column.

### 2. Eligibility and apply flow (`src/app/apply/[slug]/page.tsx`, `apply-form.tsx`, `actions.ts`)

- `page.tsx` derives two signals from `getRenewalContext`:
  - `canRenew` = active member **and** at least one current department is in this cycle (today's `eligible`).
  - `isReturning` = active member in the cycle's track (the context's `eligible`), regardless of cycle overlap.
- It passes both signals plus the person's full current-department list to the form.
- The applicant-type chooser gains a third radio, shown only when `isReturning`:
  - "New applicant" (`NEW`)
  - "Renewing in my current department" (`RENEWAL`) shown only when `canRenew`
  - "Transferring to a new department" (`TRANSFER`) shown whenever `isReturning`
- A returning member whose current department is not in this cycle sees New plus Transfer (no Renew). A returning member whose department is in the cycle sees all three.
- When `TRANSFER` is selected, the form renders the standard department-choice field (the target) and all NEW sections. The renewal-department selector stays RENEWAL-only.
- Widen the `applicantType` state and the helper signatures in `apply-form.tsx` and `actions.ts` from `"NEW" | "RENEWAL"` to include `"TRANSFER"`. The submit handler does not set `__renewalDepartment` for a transfer; the target comes through the normal answers like a new applicant.

### 3. Submission validation (`src/modules/recruitment/services/submissions.ts`)

Add a `TRANSFER` branch:

- Require sign-in (`sessionPersonId` + `sessionEmail`); reject if there is no active membership in the cycle's track. Eligibility uses the renewal context's `eligible` (active member), **not** the cycle-narrowed renewal eligibility.
- Set `applicantPersonId` from the renewal context. This reuses the existing `@@unique([cycleId, applicantPersonId])`, so a person gets at most one application per cycle (cannot both renew and transfer, cannot transfer twice).
- Derive `selectedDepartmentCodes` from the department-choice field (same extraction path as `NEW`) and validate them against the cycle's departments.
- **Nudge-to-renew rule:** reject the submission if any selected target department is in the person's current departments, with a message pointing them at the Renew path. This is the server half of decision 4.
- Store `transferFromDepartments = renewalCtx.currentDepartments`. Do not set `renewalDepartment`.

The department-choice "required" relaxation stays RENEWAL-only, so the field remains required for `TRANSFER` (they must pick a target). No change is needed there.

### 4. Form-section visibility (`src/modules/recruitment/engine/visibility.ts`)

- Add a small `scopeForApplicantType(type)` helper mapping `TRANSFER -> "NEW"` (and `NEW`/`RENEWAL` to themselves). `isSectionVisible` compares `appliesTo` against that mapped scope rather than the raw applicant type.
- Every caller already passes `applicantType`, so the apply form and the admin application-detail page both get correct sections with no further change.

### 5. Apply form nudge (`src/app/apply/[slug]/apply-form.tsx`)

- When `applicantType === "TRANSFER"` and a chosen target department is one of the person's current departments, show an inline note ("You are already in SRHD. Choose Renewing in my current department instead.") and block submit. This mirrors the server-side rule in section 3 so the user gets immediate feedback.

### 6. Admin display (applicants list and detail)

- Add one `applicantTypeLabel()` helper and use it where `applicantType` is rendered raw today:
  - `src/app/(app)/recruitment/cycles/[id]/applicants/page.tsx` (list cell)
  - `src/app/(app)/recruitment/cycles/[id]/applicants/[applicationId]/page.tsx` (detail header)
- Labels: `NEW` -> "New", `RENEWAL` -> "Renewal", `TRANSFER` -> "Transfer".
- On the detail page, when the type is `TRANSFER`, show origin context such as "Returning member, previously SRHD" sourced from `transferFromDepartments`, alongside the chosen target department(s).

### 7. Acceptance to membership (`src/modules/recruitment/services/promotion.ts`)

No change. Promotion already creates the membership from `acceptance.departmentCode`, and memberships are per term, so an accepted transfer simply gains a new-term membership in the target department with no carry-forward of the old one. A test locks this in.

## Testing

- `submissions.test.ts`:
  - A `TRANSFER` stores `applicantType=TRANSFER`, the target in `departmentChoices`, `applicantPersonId` set, and the snapshot in `transferFromDepartments`.
  - A `TRANSFER` is eligible when the person's current department is **not** in the cycle.
  - A `TRANSFER` is rejected for a non-member (no active membership).
  - A `TRANSFER` that targets a current department is rejected (nudge-to-renew).
  - The existing "renewal cannot switch departments" test still passes (renewal stays locked).
- `visibility.test.ts`: a `TRANSFER` applicant sees `NEW` sections.
- Promotion test: an accepted transfer yields a membership in the target department.
- `e2e/recruitment.spec.ts`: optionally add a transfer happy-path; note if deferred.

## Out of scope

- Transfer-specific form questions (would need `TRANSFER` in `ApplicantScope`).
- Automatically ending the person's prior-term membership (memberships are per term; the prior term is history and is not carried forward).
- Allowing a single application to both renew a current department and transfer into a new one in the same cycle.
