# Recruitment Application Portal

**Date:** 2026-06-25
**Status:** Approved design, pre-implementation

## Problem

The public application experience is a one-shot form. There is no way for an applicant to save and resume, to come back and see where their application stands, or to manage applications across cycles. New applicants are anonymous (an `Applicant` row keyed by email) and cannot sign in at all (Yale SSO only authenticates existing `Person`s), and the only status they ever receive is whatever email the recruitment team sends. All real status lives in admin-only tables (`Acceptance`, `Interview`, `OnboardingContract`, `Training`).

## Goal

A self-service applicant portal where an applicant can identify themselves, **resume a draft** application (autosaved), and **check the status** of their application(s) across cycles, with decisions surfaced only after the team releases them.

## Decisions (from brainstorming)

- **Scope:** one cohesive v1 covering identity + drafts + status. The implementation plan sequences it into stages.
- **Identity (hybrid):** Yale SSO for existing members; an emailed **magic link** for new applicants. A unified resolver returns the current applicant identity from either source.
- **Applying is identity-first:** to autosave and show status, every application is tied to a verified identity. The instant-anonymous one-shot submit is replaced by: prove your email (one magic-link click) or sign in, then fill the form. (No anonymous one-shot path in v1.)
- **Drafts autosave:** the draft *is* the `Application` in a `DRAFT` state; answers persist as the applicant types (debounced), validated only at final submit.
- **Files upload-on-select:** a `FILE` field uploads immediately and persists in the draft so it survives a resume; abandoned/replaced files are swept by a daily cron.
- **Status shows only released decisions:** neutral progress always (Draft, Submitted, Interview scheduled, Onboarding step); a final ACCEPT/REJECT/WAITLIST only after the team releases it; internal evaluations never surface.

## Architecture

### 1. Identity and session

Two entry paths, one unified identity object `ApplicantIdentity = { email: string; personId: string | null }`.

- **Members (SSO):** the existing NextAuth `Person` session. `email` is the verified Yale address (session email), `personId` is set.
- **New applicants (magic link):** a lightweight, signed **applicant-session cookie** (separate from NextAuth so member auth is untouched), carrying the verified `email` and an expiry. `personId` is null.

New service `src/modules/recruitment/services/portal-auth.ts`:
- `requestMagicLink(email: string): Promise<void>` — normalizes the email, creates a single-use token, stores its hash + expiry in `ApplicantPortalToken`, and queues a magic-link email (`recruitment.portal_link` template) with a link to `/apply/verify?token=…`. Rate-limited per email (reject if N unexpired tokens already issued in the last window).
- `verifyMagicLink(rawToken: string): Promise<{ email: string } | null>` — hashes the token, looks it up, checks not expired and not used, marks it used, returns the email. Returns null on any failure.
- `getApplicantIdentity(): Promise<ApplicantIdentity | null>` — resolves the current identity: first the NextAuth session (`auth()`; if `personId`, return `{ email: session.user.email, personId }`); else the signed applicant cookie (`{ email, personId: null }`); else null.

Cookie: `applicant_session`, httpOnly, secure, sameSite=lax, signed (HMAC over `{ email, exp }` using `AUTH_SECRET`), ~7-day expiry. Set by the verify route, cleared by an applicant sign-out action.

### 2. Drafts (autosave)

- `ApplicationStatus` gains `DRAFT` (now `DRAFT | SUBMITTED`).
- The apply form is **identity-gated**: a visitor must resolve an identity before the form renders (sign in, or verify email via magic link from the page).
- **First autosave** for `(cycle, identity)` upserts an `Applicant` (email known; `applicantPersonId` set when `personId` present) + an `Application(status=DRAFT)`. The `(cycleId, emailLower)` unique still enforces one row per cycle+email, so a draft and its later submission are the same row. The draft `Applicant`'s `firstName`/`lastName`/`phone`/`netId` stay empty until typed; the partial answers live in `Application.answers`.
- **Autosave action** `saveDraft(cycleId, answers)` — re-resolves identity, requires the cycle OPEN and the existing app not `SUBMITTED`, upserts the draft, updates `answers`. Debounced client-side. Idempotent.
- **File upload (draft)** action `uploadDraftFile(cycleId, fieldKey, file)` — same identity/cycle checks; reuses the existing `persistFiles` allowlist/size/MIME/path-safety logic; stores the object and records the file ref `{ storedName, fileName, mimeType, size }` into the draft `answers[fieldKey]`. Replacing a file deletes the prior object.
- **Submit** — `submitApplication` changes from *create-new* to *finalize-the-existing-draft*: look up the `(cycle, emailLower)` row, run the existing full validation (required fields, files, schema), update the `Applicant`'s identity fields from answers, and flip `DRAFT → SUBMITTED`. The existing duplicate pre-check is updated to distinguish state: a `DRAFT` row is the applicant's own draft and is finalized; a `SUBMITTED` row means they already applied and returns `DuplicateApplicationError`. For renewals the existing verified-session + eligibility + email-override rules still apply. A `SUBMITTED` app is read-only thereafter.
- **Orphan sweep** — a daily cron (`/api/cron/recruitment-drafts` or an addition to an existing daily cron) deletes draft `Application`s (and their `Applicant` + uploaded objects) untouched for > N days (e.g. 30), and deletes storage objects for files that were replaced. Logs what it removed.

### 3. Status portal

New service `getApplicantStatus(identity: ApplicantIdentity)` — gathers every `Applicant` matching `emailLower === identity.email` OR `applicantPersonId === identity.personId`, with their `Application`s and (for submitted ones) the downstream `Acceptance` / `Interview` / `OnboardingContract`. It returns a per-application view object the portal renders. It never reads `Evaluation` or unreleased decisions.

**Status mapping (per application):**
- `DRAFT` → "Draft, continue your application" (+ resume link, last-saved time).
- `SUBMITTED`, nothing downstream → "Submitted on `<date>`, under review."
- Interview scheduled (director) → "Interview scheduled for `<time>`" (+ join link if present).
- Onboarding in progress → "Onboarding: `<step>`" from `OnboardingContract.status` (`PENDING`/`SUBMITTED`/`PROMOTED`).
- **Final decision (release-gated):**
  - "Accepted to `<dept>`" when an `Acceptance` exists with `emailedAt` set.
  - "Not selected" / "Waitlisted" only when the cycle's decisions are released (see below) and the applicant has no acceptance (waitlist when a director `Interview.decision === "WAITLIST"`).
  - Otherwise "Under review" (never reveal an unreleased outcome).

**Release signal.** Add `decisionsReleasedAt DateTime?` to `RecruitmentCycle`, set by the existing `releaseDecisions` admin flow (which already sends acceptance emails / sets `Acceptance.emailedAt`). "Released" = `cycle.decisionsReleasedAt` is set (for negative outcomes) or the specific `Acceptance.emailedAt` is set (for accepts). This makes "show only released decisions" a single explicit gate the team controls.

### 4. Routes and UI

- `/apply` — **portal home.** Not identified: a sign-in screen (a "Sign in with Yale" button to `/login?callbackUrl=/apply`, and an email field that calls `requestMagicLink`). Identified: **"My applications"** listing each `Application` with its status view + action (*Continue* for drafts, *View status* for submitted), and a section of OPEN cycles not yet applied to with *Start application*. An applicant sign-out clears the cookie.
- `/apply/[slug]` — the **form**, identity-gated and draft-aware. Not identified → redirect to `/apply?next=/apply/<slug>`. Identified → load/create the draft, render with autosave wired (debounced `saveDraft` + `uploadDraftFile`), submit finalizes. The new/returning choice and renewal rules from the prior work remain: "returning" still requires SSO + eligibility; "new" needs any verified identity (magic link or SSO).
- `/apply/verify?token=…` — calls `verifyMagicLink`, sets the cookie on success, redirects to `next` or `/apply`; on failure shows "This link has expired, request a new one."

### Data-model changes

- `ApplicationStatus`: add `DRAFT`.
- New model `ApplicantPortalToken { id, emailLower, tokenHash, expiresAt, usedAt?, createdAt, @@index([tokenHash]), @@index([emailLower]) }`.
- `RecruitmentCycle`: add `decisionsReleasedAt DateTime?`.
- One migration for the three changes.

### Files

**New:**
- `src/modules/recruitment/services/portal-auth.ts` (+ test) — magic-link tokens, cookie, `getApplicantIdentity`.
- `src/modules/recruitment/services/portal-status.ts` (+ test) — `getApplicantStatus`.
- `src/modules/recruitment/services/drafts.ts` (+ test) — `saveDraft`, `uploadDraftFile`, draft upsert/lookup, orphan sweep.
- `src/app/apply/page.tsx` — portal home (currently `/apply` has no index; the form is at `/apply/[slug]`).
- `src/app/apply/verify/route.ts` (or page) — magic-link verification.
- `src/app/apply/portal-actions.ts` — `requestMagicLink`, applicant sign-out, `saveDraft`/`uploadDraftFile` server actions.
- A cron route for the orphan sweep (or an addition to an existing daily cron) + its registration in `vercel.json` crons.
- An email template `recruitment.portal_link`.

**Modified:**
- `prisma/schema.prisma` (+ migration) — `DRAFT`, `ApplicantPortalToken`, `decisionsReleasedAt`.
- `src/modules/recruitment/services/submissions.ts` — submit finalizes the existing draft instead of creating new.
- `src/modules/recruitment/services/decisions.ts` (the `releaseDecisions` flow) — set `cycle.decisionsReleasedAt`.
- `src/app/apply/[slug]/page.tsx` + `apply-form.tsx` — identity gate, draft load, autosave wiring.

## Security

- **Applicant cookie:** signed (HMAC with `AUTH_SECRET`), httpOnly, secure, sameSite=lax. Carries only the verified email + expiry; cannot be forged or read by JS.
- **Magic tokens:** single-use (`usedAt`), expiring (~30 min), hashed at rest (only the hash is stored), rate-limited per email.
- **Strict data isolation:** every draft read/write, file upload, and status query is scoped to the resolved identity (`emailLower` and/or `personId`). An applicant can only ever see or modify their own `(cycle, email)` data. The magic link proves email ownership; SSO proves the Person.
- **Autosave/upload guards:** re-resolve identity on every call; require the cycle OPEN; reject edits to a `SUBMITTED` application; uploads reuse the submit-path allowlist/size/MIME/path-safety checks.
- **No decision leakage:** `getApplicantStatus` surfaces only released outcomes (per the release signal) and never reads `Evaluation` or unreleased `Interview`/`Acceptance` state.
- **Renewal integrity preserved:** the existing verified-session + eligibility + server-side email override for renewals is unchanged.

## Error handling

- Expired/used/invalid magic token → "This link has expired, request a new one."
- Rate-limited magic-link request → "We just sent a link, check your email."
- Cycle closes mid-draft → submit blocked with a clear message; the draft is preserved (read-only).
- Autosave failure → silent retry with a subtle "couldn't save, retrying" indicator; never lose the in-memory answers.
- Submit validation errors → the same per-field errors as today.
- Identity lost (cookie expired) mid-session → redirect to `/apply` sign-in, preserving `next`.

## Testing

Run against the per-worktree `TEST_DATABASE_URL`. Node-env Vitest (no DOM): logic + DB paths are unit-tested; UI verified by typecheck/lint/build + manual.

- **portal-auth:** token issue → verify (single-use: second verify fails) → expiry rejected; rate-limit; `getApplicantIdentity` resolves cookie vs SSO vs none.
- **drafts:** first `saveDraft` creates one `Applicant`+`Application(DRAFT)`; subsequent saves update the same row (no duplicates) and respect the `(cycle, emailLower)` unique; `uploadDraftFile` records a ref and replacing deletes the prior object; `saveDraft` rejects when the cycle is closed or the app is `SUBMITTED`; orphan sweep removes abandoned drafts + objects.
- **submit finalization:** submitting a draft flips it to `SUBMITTED`, updates the existing `Applicant`'s name fields from answers, and does NOT create a second `Applicant`; renewal rules still hold.
- **portal-status:** neutral progress for draft/submitted/interview/onboarding; "Accepted to X" only when `emailedAt`; "Not selected"/"Waitlisted" only when `decisionsReleasedAt` set and no acceptance; never reads evaluations; a draft surfaces as resume.
- **isolation:** identity A cannot read or write identity B's draft/status; a `SUBMITTED` app cannot be edited; an expired token cannot set a session.

## Out of scope (v1)

- Anonymous one-shot applying (replaced by identity-first).
- Withdrawing or editing a submitted application from the portal.
- In-portal messaging/notifications beyond status display (decisions still go out by email too).
- Showing interview evaluation feedback or panel scores to applicants (never).
- A separate applicant account with a password (magic link + SSO only).
- Cross-cycle application copying / "apply again with last year's answers."
