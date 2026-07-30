# Onboarding ends on a dead end (2026-07-30)

## Problem

An accepted volunteer signs the onboarding contract. The page is replaced by one sentence:

> Thanks, your onboarding is complete. We will be in touch with next steps.

`src/app/onboard/[token]/onboard-form.tsx:87` renders that as a single `<Alert tone="success">`. The
DOM contains **zero links and zero buttons**. It is the last thing someone sees before they are
expected to show up to a clinic shift.

Nothing is actually in flight. `submitContract` queues no email and creates no notification;
`EmailLog` gained no row when the audit walked it. The Epic section one screen earlier had promised
"We will set up your Epic account. Directions follow after you submit this form." No directions
follow. The volunteer has never signed into HAVEN Hub and is given no route into it. The applicant
portal afterwards says only "Onboarding in progress / Form submitted", with no action.

Then, if they reopen the link later, to check what they signed or because they bookmarked it,
`src/app/onboard/[token]/page.tsx:15` gates on `!contract || contract.status !== "PENDING"` and
renders:

> This onboarding form is not available. The link may be invalid or already completed.
> Need a new link? Contact the HAVEN Free Clinic IT team.

So completing the task successfully produces, on revisit, a failure message and an instruction to
email IT.

Audit finding **R4** (F-04-3 + F-04-11 merged), PR #474, ranked 4th of 88, tier 1, reach "every
accepted volunteer, once per cycle".

## Goals

Tell a newly onboarded volunteer what happens next and how to get into the app, and make revisiting
the link a confirmation rather than an error.

## Non-goals

- Any change to what the contract collects, how it validates, or how acceptances are recorded.
- Epic provisioning itself. This delivers the directions the form already promised; it does not
  change how accounts are created.
- The applicant portal's "Onboarding in progress" card. It is a related gap and worth its own look,
  but it is a different surface and not what this finding is about.

## Design

### One content module, three consumers

The next-steps content is needed in three places: the completion screen, the revisit page, and the
confirmation email. Write it once.

If it is written three times it will drift, which is precisely the defect the previous branch in
this series spent two review rounds fixing on a two-consumer sentence. A shared module makes the
mirroring structural rather than a promise in a comment.

### 1. Replace the completion screen

The screen should carry, at minimum:

- **How to sign in.** Branch on the volunteer's email domain: a Yale address gets "Sign in with
  your Yale NetID"; anything else gets "We will email you a sign-in link." That matches how login
  actually works, since Yale addresses must use SSO and non-Yale members use an emailed magic link.
  A generic "sign in here" is wrong for half the population, because a non-Yale volunteer landing on
  a page dominated by an SSO button will not realise the magic-link form is their route.
- **The in-person training date and location.** Both are already resolved server-side at
  `src/app/onboard/[token]/page.tsx:89-90` and passed into the contract context at `:105`, so the
  data is in scope. Handle the null cases; `training-date.ts:7` returns "the scheduled training
  date" when no date is set.
- **The Epic directions the form promised**, so the promise made one screen earlier is kept.
- **What happens on the director's side**, so the volunteer knows whether they are waiting on
  someone.

### 2. Queue a confirmation email

In `submitContract`, queue an email carrying the same next-steps content.

**Corrected 2026-07-30, before planning.** This section first said to follow the platform pattern:
a helper rendering through `renderEmail("<descriptor>", context)` and dispatching through
`notify()`, with a new `NOTIFICATION_TYPES` entry. That is the wrong pattern here.

This module already sends the onboarding **link** through the recruitment cycle-email system
(`onboarding.ts:186-196` calls `renderCycleEmail(cycle.id, "recruitment.onboarding", ...)` then
`queueEmail`). Those keys live in `CYCLE_EMAIL_KEYS` at
`src/modules/recruitment/email/render.ts:9-14` and are **overridable per cycle**, which is the
whole point of the recruitment email customization feature.

A confirmation sent when a volunteer completes a cycle's contract is a cycle email by the same
logic as the acceptance and the onboarding link that precede it. Ops will expect to edit it per
cycle alongside those, not find it in a different admin surface.

So: add a key to `CYCLE_EMAIL_KEYS`, give it a default subject and body, and render through
`renderCycleEmail` beside the existing send. No `NOTIFICATION_TYPES` entry, no `notify()`
dispatcher, because this is not a per-person notification with channel routing; it is a
transactional recruitment email to one address the contract already holds
(`OnboardingContract.email`).

**Scope note.** The audit sized R4 as `M`. With a shared content module, an email template, and the
token-page branch, it is realistically `L`. The same under-sizing happened on R19 in the HIPAA
branch, for the same reason: the audit counts the visible change and not the template plumbing.

**Failure isolation.** The contract is already durably submitted and audited by the time the email
is queued. A notification failure must not surface to the volunteer as a failed submission. Wrap it
the way `saveCertificate` wraps its manager alerts: catch, log, continue.

### 3. Make revisiting the link a confirmation

Branch `page.tsx:15` on contract status:

- `SUBMITTED` and `PROMOTED`: render a confirmation ("You completed this on {date}") plus the same
  next-steps content.
- Unknown or expired token: keep the existing error.

The current single branch treats "you already did this" and "this link is broken" as the same
event, and tells the volunteer to email IT about their own success.

## Testing

- The completion screen renders at least one actionable route into the app, and the sign-in copy
  differs for a Yale and a non-Yale address.
- `submitContract` queues exactly one confirmation email, and none on a repeat submit. The HIPAA
  branch's equivalent test caught a real double-send risk; this needs the same guard.
- A notification failure does not fail the submission.
- Revisiting a `SUBMITTED` contract renders the confirmation, not the error.
- An unknown token still renders the error.
- The training date and location render correctly when the cycle has neither set.

## Risks

- **This is copy a volunteer reads once, at the moment they need it.** Every string is drafted to be
  edited in review. Do not invent Epic instructions, timelines, or anything about what directors do
  next; state only what the code and the cycle's stored fields support.
- **The email is a new outbound message to every accepted volunteer.** It fires once per contract
  submission. That is the intent, but it is the first thing to check if send volume looks wrong.
- **A `PROMOTED` contract may have data a `SUBMITTED` one does not.** Confirm what that status means
  before assuming the same content renders correctly for both.
