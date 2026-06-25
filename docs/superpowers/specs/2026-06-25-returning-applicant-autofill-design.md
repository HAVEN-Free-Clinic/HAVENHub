# Returning-Applicant Sign-In and Auto-Fill

**Date:** 2026-06-25
**Status:** Approved design, pre-implementation

## Problem

On the public application page (`/apply/[slug]`), a returning volunteer retypes information HAVEN Hub already knows (name, email, department) every recruitment cycle. The form has a "Renewing in my current department" choice, but it only filters which sections show; it does not authenticate the applicant or prefill anything, and submissions are stored as anonymous `Applicant` records with no link to the person's account.

## Goal

When an applicant chooses "Returning volunteer," require them to sign in with Yale (Microsoft Entra ID), verify they are a current volunteer, pre-fill their known information, and link the resulting submission to their `Person` account. New applicants are unaffected and remain anonymous.

## Decisions (from brainstorming)

- **Scope:** Require sign-in for renewals. Returning volunteers must authenticate; the submission is linked to their `Person` and the renewal is verified. New applicants stay anonymous (unchanged flow). Sign-in is offered only on the "Returning volunteer" branch.
- **Eligibility:** A signed-in user is eligible to renew if they have an `ACTIVE` `VOLUNTEER` `TermMembership` in their most-recent term. The department(s) from that membership are their current department(s): one department auto-sets the renewal department; multiple lets them choose among their own; zero means not eligible.
- **Not-eligible fallback:** Show a calm note ("We don't see a current volunteer membership for your account") and auto-switch them into the New-applicant flow. Their verified name and email stay prefilled; department fields are cleared.
- **Field treatment after sign-in:**
  - Yale email: **locked** (read-only). It is SSO-authoritative and the dedup key. The server re-derives it at submit and never trusts the client value.
  - First / last name: prefilled, **editable** (we split the single `Person.name`, which can be imperfect).
  - Department: prefilled to the current membership department, **selectable** among the cycle's departments (a returning volunteer may choose to renew into a different department).
  - Phone and all other answers: prefilled, editable.
- **Auth mechanics:** Approach A. The existing public apply page reads the session optionally via `auth()`; sign-in is a NextAuth redirect with a `callbackUrl` back to the apply page; all verification happens server-side (page load and submit).

## Architecture

### 1. Data model

`prisma/schema.prisma`, `Applicant` model:
- Add `applicantPersonId String?` and the relation `applicantPerson Person? @relation("ApplicantPerson", fields: [applicantPersonId], references: [id], onDelete: SetNull)`.
- Add `@@index([applicantPersonId])`.
- Add `@@unique([cycleId, applicantPersonId])` to prevent the same person applying twice to one cycle. Postgres treats `NULL`s as distinct, so multiple anonymous (new) applicants in a cycle are unaffected; only non-null `applicantPersonId`s are deduped.
- Keep the existing `@@unique([cycleId, emailLower])`.

`Person` model: add the back-reference `applicantSubmissions Applicant[] @relation("ApplicantPerson")`.

For a signed-in renewal, `applicantPersonId` is set. For a new applicant it is `null`.

One migration (`prisma migrate dev`), applied to the test DB and (per the deploy notes) checked with `prisma migrate status` against Neon before deploy.

### 2. Eligibility and prefill service

New file `src/modules/recruitment/services/renewal.ts`:

- `getRenewalContext(personId: string, sessionEmail: string | null): Promise<RenewalContext>` where
  `type RenewalContext = { personId: string; name: string | null; email: string | null; netId: string | null; phone: string | null; currentDepartments: string[]; eligible: boolean }`.
  It loads the person and their active `VOLUNTEER` `TermMembership`s in the most-recent term, takes that term's department codes as `currentDepartments`, and sets `eligible = currentDepartments.length > 0`. It returns `email = sessionEmail` verbatim (the Entra-verified Yale address), not a possibly-stale `Person.contactEmail`. The exact predicate for "active membership" (the `TermMembership` status/active field name and how "most-recent term" is selected) is confirmed against `prisma/schema.prisma` during planning; the intent is "a person who is currently an active volunteer."
- `resolveRenewalPrefill(fields: { key: string; type: string }[], ctx: RenewalContext): { values: Record<string, string>; lockedKeys: string[] }` maps the context onto the cycle's field keys:
  - `first_name` ← first whitespace-delimited token of `ctx.name`; `last_name` ← the remainder (empty string if `name` has one token).
  - a field with `type === "EMAIL"` or `key === "email"` ← `ctx.email`; that field's key is added to `lockedKeys`.
  - a field with `type === "PHONE"` or `key === "phone"` ← `ctx.phone`.
  - a field with `key === "netid"` ← `ctx.netId`.
  - department is handled by the form's renewal-department control, not by a regular field, so it is not in `values`.
  - any field whose key/type matches nothing is left unset (graceful: off-convention forms simply do not prefill).

**Email source.** The authoritative Yale email is the NextAuth session email (the Entra-verified address), passed as `getRenewalContext`'s `sessionEmail` argument and returned verbatim as `ctx.email`. We never trust `Person.contactEmail` (mutable) or the client-submitted email for the locked field.

### 3. Apply page (server) — `src/app/apply/[slug]/page.tsx`

- Call `auth()` (optional; returns `null` when not signed in).
- Read `searchParams.type` (`"renewal"` re-selects the Returning branch after the sign-in redirect).
- When a session with `personId` exists, build `RenewalContext` via `getRenewalContext(personId)` (passing the session email) and `resolveRenewalPrefill(cycleFields, ctx)`.
- Pass to `ApplyForm`: `signedIn: boolean`, `signedInName: string | null`, `eligible: boolean`, `prefill: Record<string,string>`, `lockedKeys: string[]`, `currentDepartments: string[]`, and `initialApplicantType: "NEW" | "RENEWAL"` (derived from `?type`).
- No session → pass `signedIn: false` and empty prefill; the form behaves as today for new applicants.

### 4. Apply form (client) — `src/app/apply/[slug]/apply-form.tsx`

The Returning branch (only rendered when `def.acceptsRenewals`) has three states:

- **Not signed in:** the "Returning volunteer" card, when selected, reveals a primary "Sign in with Yale" button that calls `signIn("microsoft-entra-id", { callbackUrl: "/apply/<slug>?type=renewal" })`. The remaining renewal fields/sections are hidden until signed in, with one line explaining why (verify your renewal and autofill).
- **Signed in + eligible:** a "Signed in as <name>" line; the form renders with `prefill` applied (email locked, name/phone editable); the renewal-department select defaults to the person's current department and lists the cycle's departments (selectable).
- **Signed in + not eligible:** a calm note and auto-switch to New applicant (`applicantType = "NEW"`); name/email stay prefilled, department is cleared.

Prefill is applied through `FieldPreview` (new optional props below). The sign-in button uses NextAuth `signIn` from `next-auth/react`.

### 5. Shared renderer — `src/modules/recruitment/components/field-preview.tsx`

Add two optional props: `prefill?: string` and `locked?: boolean`.
- For text-like controls (`SHORT_TEXT`, `EMAIL`, `PHONE`, `NUMBER`, `DATE`, `LONG_TEXT`): when `locked`, render `value={prefill}` + `readOnly` (and a muted/disabled affordance); otherwise `defaultValue={prefill}` when `prefill` is provided.
- Other control types ignore `prefill`/`locked` for v1 (department prefill is handled by the form's renewal-department control, not a regular field).
- The builder passes neither prop, so its behavior is unchanged.

### 6. Submit verification — `actions.ts` + `submissions.ts`

- `src/app/apply/[slug]/actions.ts`: `submitPublicApplication` calls `auth()` and passes `sessionPersonId: string | null` and `sessionEmail: string | null` into `submitApplication`.
- `src/modules/recruitment/services/submissions.ts`, `submitApplication`:
  - When `applicantType === "RENEWAL"`:
    - **Require** `sessionPersonId` (throw a `SubmitError` if absent — the UI gates this, the server enforces it).
    - Re-fetch the person + eligibility via `getRenewalContext`. If not eligible, reject (membership changed since load).
    - **Override** the identity email with the verified session email (ignore the client-submitted email value), and validate the chosen `renewalDepartment` is one of the cycle's departments.
    - Set `applicantPersonId = sessionPersonId` on the created `Applicant`.
  - When `applicantType === "NEW"`: unchanged; `applicantPersonId` stays `null`.
  - Dedup: the existing `(cycleId, emailLower)` plus the new `(cycleId, applicantPersonId)` unique constraints. Catch the unique-violation and return a friendly "you have already applied to this cycle" result rather than a 500.

### Files

**New:**
- `src/modules/recruitment/services/renewal.ts`
- `src/modules/recruitment/services/renewal.test.ts`
- `prisma/migrations/<timestamp>_applicant_person_link/migration.sql`

**Modified:**
- `prisma/schema.prisma` — `Applicant.applicantPersonId` + relation + indexes/unique; `Person.applicantSubmissions` back-ref.
- `src/app/apply/[slug]/page.tsx` — optional `auth()`, renewal context + prefill, `?type`, new props.
- `src/app/apply/[slug]/apply-form.tsx` — three-state Returning branch, sign-in button, prefill/lock application, department default.
- `src/modules/recruitment/components/field-preview.tsx` — optional `prefill`/`locked`.
- `src/app/apply/[slug]/actions.ts` — read session, pass `sessionPersonId`/`sessionEmail`.
- `src/modules/recruitment/services/submissions.ts` — renewal session gate, server-side email override, `applicantPersonId`, duplicate handling.

## Error handling

- Renewal submit with no session → `SubmitError` ("Please sign in to apply as a returning volunteer"). The UI prevents reaching this, so it is a backstop.
- Eligibility lost between load and submit → rejected as not eligible with a clear message.
- Duplicate (same person + cycle, or same email + cycle) → caught unique violation returns a friendly already-applied result.
- Client tampering with the locked email or applicantType → server re-derives email from the session and re-validates eligibility, so tampering cannot spoof identity.
- Off-convention field keys → simply not prefilled (no error).

## Testing

Run against the per-worktree `TEST_DATABASE_URL`. Vitest is node-env (no DOM), so form-state UI is verified by typecheck/lint/build + manual; logic and DB paths are unit-tested.

- `renewal.test.ts`:
  - `getRenewalContext` returns `eligible: true` + the department(s) for an active VOLUNTEER membership; `eligible: false` with empty departments when there is none; returns multiple departments when the person holds several active VOLUNTEER memberships.
  - `resolveRenewalPrefill` splits `name` into first/last, maps email by `type EMAIL`/key `email` and marks it locked, maps phone by `type PHONE`/key `phone`, maps `netid`, and skips off-convention keys.
- `submissions.test.ts` additions:
  - A `RENEWAL` submit with `sessionPersonId === null` is rejected.
  - A `RENEWAL` submit by an eligible person sets `applicantPersonId` and stores the verified session email even when the submitted email differs.
  - A second `RENEWAL` submit by the same person to the same cycle is rejected as a duplicate.
  - A `NEW` submit is unchanged and leaves `applicantPersonId` null.

## Out of scope (v1)

- Sign-in / autofill for NEW applicants (they stay anonymous by decision).
- Prefilling non-identity answers from prior submissions (e.g. last cycle's essay).
- Department prefill for arbitrary `DEPARTMENT_CHOICE` fields beyond the renewal-department control.
- Merging or reconciling an anonymous `Applicant` with a `Person` after the fact.
- Editing which `Person` fields are authoritative (out of this feature; see the existing my-info profile).
